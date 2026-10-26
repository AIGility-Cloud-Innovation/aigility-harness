/**
 * filterIgnored 回归测试（2026-10-25 事故）：
 * .backups/ 被 .gitignore 忽略时，交付前必须剔除，否则 git add 致命失败。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { TaskRecord } from "@aigility-harness/core";
import { filterIgnored, createPrFinisher } from "./pr-finisher.js";

// 交付成功后 PingCode 同步属旁路且会走外网；单测里直接短路，保证离线可跑
vi.mock("./pingcode-sync.js", () => ({ deliverPingcodeFixed: async () => undefined }));

/** 沙箱内 execFileSync 的 stdin 管道会 EPERM；显式 ignore stdin 后离线可跑 */
function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
}

function repoWith(ignore: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fi-"));
  gitSync(dir, ["init", "-q"]);
  writeFileSync(join(dir, ".gitignore"), ignore);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".backups", "snap-1"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".backups", "snap-1", "index.html"), "<html></html>\n");
  return dir;
}

describe("filterIgnored", () => {
  it("剔除 .gitignore 覆盖的 .backups 路径，保留真实改动", async () => {
    const dir = repoWith(".backups/\n");
    const kept = await filterIgnored(["src/a.ts", ".backups/snap-1/index.html"], dir);
    expect(kept).toEqual(["src/a.ts"]);
  });

  it("没有忽略规则时原样返回", async () => {
    const dir = repoWith("# 空\n");
    const files = ["src/a.ts", ".backups/snap-1/index.html"];
    expect(await filterIgnored(files, dir)).toEqual(files);
  });

  it("全部被忽略时返回空数组（调用方据此报「无可交付文件」）", async () => {
    const dir = repoWith(".backups/\n");
    expect(await filterIgnored([".backups/snap-1/index.html"], dir)).toEqual([]);
  });

  it("空列表直接返回空", async () => {
    expect(await filterIgnored([], "/tmp")).toEqual([]);
  });

  it("打印一行跳过汇总日志（便于事后核对）", async () => {
    const dir = repoWith(".backups/\n");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await filterIgnored(["src/a.ts", ".backups/snap-1/index.html"], dir);
      expect(spy.mock.calls.some(([msg]) => String(msg).includes("已跳过 1 个忽略路径"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [".backups/", ".backups/x/index.html"],
    ["node_modules/", "node_modules/pkg/index.js"],
    ["dist/", "dist/bundle.js"],
    ["*.log", "logs/app.log"],
    [".pytest_cache/", ".pytest_cache/v/cache/lastfailed"],
    [".hermes/", ".hermes/cache/scratch/x.json"],
  ])("%s 规则命中的路径被跳过", async (rule, file) => {
    const dir = repoWith(`${rule}\n`);
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "artifact\n");
    expect(await filterIgnored([file, "src/a.ts"], dir)).toEqual(["src/a.ts"]);
  });
});

const task = (): TaskRecord =>
  ({
    uid: "tsk_c03ce9c0",
    title: "【agent】[TiMEM-AI/timem-platform-backend] 收尾忽略备份目录",
    description: "收尾提交只含真实代码改动。",
    status: "ready",
    projectRef: "TiMEM-AI/timem-platform-backend",
  }) as TaskRecord;

describe("createPrFinisher 提交清单", () => {
  it("工作区有 src/a.ts 与 .backups/x/index.html → 提交只含 src/a.ts", async () => {
    const base = mkdtempSync(join(tmpdir(), "pr-finisher-ignored-"));
    const repo = join(base, "repo");
    const origin = join(base, "origin.git");
    gitSync(base, ["init", "--bare", "-q", origin]);
    gitSync(base, ["init", "-q", "-b", "main", repo]);
    gitSync(repo, ["config", "user.email", "t@t"]);
    gitSync(repo, ["config", "user.name", "t"]);
    gitSync(repo, ["config", "commit.gpgsign", "false"]);

    // 历史上被误提交的备份文件：本轮修改后仍会出现在 status 中（真实事故形态）
    writeFileSync(join(repo, ".gitignore"), ".backups/\nnode_modules/\ndist/\n*.log\n.pytest_cache/\n.hermes/\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "seed.ts"), "export const seed = 1;\n");
    mkdirSync(join(repo, ".backups", "x"), { recursive: true });
    writeFileSync(join(repo, ".backups", "x", "index.html"), "<html>old</html>\n");
    gitSync(repo, ["add", "-f", ".gitignore", "src/seed.ts", ".backups/x/index.html"]);
    gitSync(repo, ["commit", "-q", "--no-gpg-sign", "-m", "seed"]);
    gitSync(repo, ["remote", "add", "origin", origin]);
    gitSync(repo, ["push", "-q", "-u", "origin", "main"]);
    gitSync(repo, ["checkout", "-q", "-b", "agent/ignored-regression"]);

    writeFileSync(join(repo, ".backups", "x", "index.html"), "<html>new</html>\n");
    mkdirSync(join(repo, ".backups", "y"));
    writeFileSync(join(repo, ".backups", "y", "index.html"), "<html>untracked</html>\n");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");

    const finisher = createPrFinisher({
      giteaCall: async () => ({ ok: true, value: { status: 201, data: { number: 1, html_url: "https://pr/1" } } }),
      baseBranch: "main",
    });
    const r = await finisher({
      task: task(),
      cwd: repo,
      member: "codex",
      summary: "完成",
      preExisting: [],
      branch: "agent/ignored-regression",
    });
    expect(r.ok, `detail=${r.detail}`).toBe(true);

    const committed = gitSync(repo, ["show", "--pretty=format:", "--name-only", "HEAD"])
      .split("\n")
      .filter(Boolean);
    expect(committed).toEqual(["src/a.ts"]);
    // 备份目录仍留在工作区（不删除、不提交）
    const status = gitSync(repo, ["status", "--porcelain", "--ignored", "--untracked-files=all"]);
    expect(status).toContain(" M .backups/x/index.html");
    expect(status).toContain("!! .backups/y/index.html");
    expect(status).not.toContain("src/a.ts");
  });
});
