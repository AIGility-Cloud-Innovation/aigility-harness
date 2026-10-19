import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBaseBranch,
  ensureWorktree,
  worktreeDirName,
  worktreeBranch,
} from "./worktree-manager.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).toString();
}

/**
 * 建一个带 origin 的临时仓库：main 与 feat-x 两条线。
 * withOriginHead=false 时删掉 origin/HEAD（复现 2026-10-15 事故当天状态）。
 */
function makeRepo(opts: { withOriginHead?: boolean } = {}): { root: string; bare: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wtm-test-"));
  const bare = join(dir, "origin.git");
  const root = join(dir, "work");

  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: GIT_ENV });
  execFileSync("git", ["clone", bare, root], { stdio: "ignore", env: GIT_ENV });
  git(root, "checkout", "-b", "main");
  execFileSync("bash", ["-c", `echo a > '${root}/f.txt'`], { stdio: "ignore" });
  git(root, "add", "-A");
  git(root, "commit", "-m", "init");
  git(root, "push", "-u", "origin", "main");

  git(root, "checkout", "-b", "feat-x");
  execFileSync("bash", ["-c", `echo b >> '${root}/f.txt'`], { stdio: "ignore" });
  git(root, "add", "-A");
  git(root, "commit", "-m", "feat");
  git(root, "push", "-u", "origin", "feat-x");
  git(root, "checkout", "feat-x"); // 停在 feat-x（模拟「服务实际跑在特性分支」）

  if (!opts.withOriginHead) {
    try {
      git(root, "remote", "set-head", "origin", "--delete");
    } catch {
      /* 已无 origin/HEAD */
    }
  }
  return { root, bare, dir };
}

describe("resolveBaseBranch（三级探测 Q1-A）", () => {
  const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
  afterEach(() => {
    if (saved === undefined) delete process.env["WORKER_TEAM_BASE_BRANCH"];
    else process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
  });

  it("① env 显式配置最高优先（压过一切）", async () => {
    const { root, dir } = makeRepo();
    process.env["WORKER_TEAM_BASE_BRANCH"] = "release/2026";
    const r = await resolveBaseBranch(root);
    expect(r.base).toBe("release/2026");
    expect(r.source).toContain("env");
    rmSync(dir, { recursive: true, force: true });
  });

  it("③ origin/HEAD 缺失时回落到「目标仓库实际 HEAD 分支」（事故场景）", async () => {
    const { root, dir } = makeRepo({ withOriginHead: false });
    const r = await resolveBaseBranch(root);
    expect(r.base).toBe("feat-x");
    expect(r.source).toContain("HEAD");
    rmSync(dir, { recursive: true, force: true });
  });

  it("origin/HEAD 存在时优先用它（②）", async () => {
    const { root, dir } = makeRepo({ withOriginHead: false });
    try {
      git(root, "remote", "set-head", "origin", "main");
    } catch {
      git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    }
    const r = await resolveBaseBranch(root);
    expect(r.base).toBe("main");
    expect(r.source).toBe("origin/HEAD");
    rmSync(dir, { recursive: true, force: true });
  });

  it("非 git 目录 → 最终兜底 dev（2026-10-19 整改①：流程=从 dev 切特性分支，不抛）", async () => {
    const r = await resolveBaseBranch("/nonexistent-wtm-test-dir");
    expect(r.base).toBe("dev");
    expect(r.source).toBe("fallback:dev");
  });
});

describe("ensureWorktree（基线正确 + fetch 失败拒绝派发 Q2-B）", () => {
  const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
  beforeEach(() => { delete process.env["WORKER_TEAM_BASE_BRANCH"]; });
  afterEach(() => {
    if (saved === undefined) delete process.env["WORKER_TEAM_BASE_BRANCH"];
    else process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
  });

  it("基线跟随目标仓库实际 HEAD，分支从该基线切出（不再硬编码 main）", async () => {
    const { root, dir } = makeRepo({ withOriginHead: false });
    const wtRoot = join(dir, "wts");
    const r = await ensureWorktree({
      repoRoot: root,
      taskUid: "T1abc123",
      title: "测试任务",
      root: wtRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.base).toBe("feat-x");
    expect(r.path && existsSync(r.path)).toBe(true);
    const content = execFileSync("bash", ["-c", `cat '${r.path}/f.txt'`]).toString();
    expect(content).toContain("b"); // feat-x 的内容
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("fetch 失败（origin 不可达）→ ok:false 拒绝派发，不退回陈旧引用", async () => {
    const { root, dir } = makeRepo({ withOriginHead: false });
    const wtRoot = join(dir, "wts2");
    git(root, "remote", "set-url", "origin", "/nonexistent-remote-xyz.git");
    const r = await ensureWorktree({
      repoRoot: root,
      taskUid: "T2def456",
      title: "测试任务",
      root: wtRoot,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("fetch");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

describe("命名函数", () => {
  it("worktreeDirName：<repo 短名>-<uid 后 6 位>", () => {
    expect(worktreeDirName("/a/b/my-repo", "tsk_1f2e3d4c5b6a")).toBe("my-repo-4c5b6a");
  });
  it("worktreeBranch：agent/ 前缀 + slug + uid 后缀", () => {
    expect(worktreeBranch("tsk_1f2e3d4c5b6a", "修 402 bug")).toMatch(/^agent\/.*4c5b6a$/);
  });
});