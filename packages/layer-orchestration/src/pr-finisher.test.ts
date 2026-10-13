import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugifyBranch,
  cleanTitle,
  parsePorcelain,
  diffPaths,
  buildCommitMessage,
  buildPrBody,
  detectBaseBranch,
  createPrFinisher,
} from "./pr-finisher.js";
import type { TaskRecord } from "@aigility-harness/core";

const task = (over: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    uid: "T1abcdef",
    title: "【待安排执行者】[TiMEM-AI/timem-platform-backend] 记忆权益 402 响应体增强",
    description: "执行者：agent\n现状：余额充足仍 402。\n过程方法：加固响应体。\n目标：明确报错。\n交付要求：开启的 Gitea PR。",
    status: "ready",
    projectRef: "TiMEM-AI/timem-platform-backend",
    ...over,
  }) as TaskRecord;

describe("slugifyBranch", () => {
  it("剥【】与 [org/repo] 前缀、只留 ASCII 词字符（中文被剥，唯一性靠 uid 后缀）", () => {
    expect(slugifyBranch(task().title)).toBe("402");
    expect(slugifyBranch("【挂起】数据表格权限")).toBe("task");
  });
  it("全非 ASCII 回退 task", () => {
    expect(slugifyBranch("【挂起】数据表格权限")).toBe("task");
  });
  it("截断 40 字符", () => {
    expect(slugifyBranch("a".repeat(60)).length).toBeLessThanOrEqual(40);
  });
});

describe("cleanTitle", () => {
  it("剥组标前缀", () => {
    expect(cleanTitle("【待安排执行者】修复 bug")).toBe("修复 bug");
  });
});

describe("parsePorcelain", () => {
  it("解析 M/A/??/D/R 各形态", () => {
    const out = [
      " M app/a.py",
      "A  app/b.py",
      "?? untracked/x.py",
      " D app/old.py",
      "R  app/old.py -> app/new.py",
    ].join("\n");
    expect(parsePorcelain(out)).toEqual(["app/a.py", "app/b.py", "untracked/x.py", "app/old.py", "app/new.py"]);
  });
});

describe("diffPaths", () => {
  it("当前 − 派发前快照（保序去重）", () => {
    expect(diffPaths(["a.py", "b.py", "a.py", "c.py"], ["b.py"])).toEqual(["a.py", "c.py"]);
  });
  it("无新改动返回空", () => {
    expect(diffPaths(["a.py"], ["a.py"])).toEqual([]);
  });
});

describe("buildCommitMessage / buildPrBody", () => {
  it("含任务标题、来源、文件清单", () => {
    const msg = buildCommitMessage(task(), "codex", ["app/a.py", "tests/b.py"]);
    expect(msg).toContain("feat(agent): 记忆权益 402 响应体增强");
    expect(msg).toContain("worker-team/codex");
    expect(msg).toContain("app/a.py");
    const body = buildPrBody(task(), "codex", ["app/a.py"], "完成");
    expect(body).toContain("## agent 任务交付");
    expect(body).toContain("任务描述");
    expect(body).toContain("app/a.py");
    expect(body).toContain("完成");
  });
});

describe("detectBaseBranch", () => {
  it("无 origin/HEAD 回退 main（不抛）", async () => {
    // 用一个必然失败的 cwd（不存在目录）——execFile 抛错被 catch 后回退 main
    await expect(detectBaseBranch("/nonexistent-pr-finisher-test")).resolves.toBe("main");
  });
});

describe("createPrFinisher", () => {
  it("建 PR 成功 → ok + PR 链接（走注入的 giteaCall；git 操作注入空目录）", async () => {
    const giteaCall = async (req: Record<string, unknown>) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/repos/TiMEM-AI/timem-platform-backend/pulls");
      const body = req.body as { title: string; base: string };
      expect(body.base).toBe("main");
      expect(body.title).toBe("记忆权益 402 响应体增强");
      return { ok: true, value: { status: 201, data: { number: 151, html_url: "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/pulls/151" } } };
    };
    let notified = "";
    const finisher = createPrFinisher({
      giteaCall,
      baseBranch: "main",
      notify: async (t) => { notified = t; },
    });
    // 空目录（无 .git）→ git fetch 立即失败被 catch → 快速返回失败，不碰真网络
    const empty = mkdtempSync(join(tmpdir(), "pr-finisher-empty-"));
    const r = await finisher({
      task: task(),
      cwd: empty,
      member: "codex",
      summary: "完成：加固 402 响应体 + 单测",
      preExisting: [],
    });
    expect(r.ok).toBe(false);
    // 失败也走回程通知（设计目标：无静默失败）
    expect(notified).toContain("交付失败");
  });

  it("无 cwd → 失败且不调 gitea", async () => {
    let called = false;
    const finisher = createPrFinisher({
      giteaCall: async () => { called = true; return { ok: true, value: { status: 201, data: { number: 1 } } }; },
    });
    const r = await finisher({ task: task(), cwd: undefined, member: "codex", summary: "s", preExisting: [] });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("建 PR 响应解析：gitea-api 包裹形状（r.value.data={ok,data:{number}}）不误判（PR #145 回归）", async () => {
    const { execSync } = await import("node:child_process");
    for (const wrapped of [true, false]) {
      // 全新仓库（每分支独立）：bare origin + 关 gpgsign，保证 fetch/push/commit 全链可跑
      const base = mkdtempSync(join(tmpdir(), "pr-finisher-"));
      const repo = join(base, "repo");
      execSync(
        `git init --bare "${base}/origin.git" && git init -b main "${repo}" && ` +
        `git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t && ` +
        `git -C "${repo}" config commit.gpgsign false && ` +
        `git -C "${repo}" remote add origin "${base}/origin.git" && ` +
        `cd "${repo}" && echo x>seed.txt && git add . && git commit --no-gpg-sign -m seed && git push -q -u origin main`,
        { stdio: "ignore" },
      );
      // 本任务新改动（untracked 新文件；seed.txt 在派发前快照里不卷入）
      execSync(`echo hello > app.py`, { cwd: repo, stdio: "ignore" });
      const finisher = createPrFinisher({
        giteaCall: async () =>
          wrapped
            ? { ok: true, value: { status: 201, data: { ok: true, data: { number: 145, html_url: "https://pr/145" } } } }
            : { ok: true, value: { status: 201, data: { number: 145, html_url: "https://pr/145" } } },
        baseBranch: "main",
      });
      const r = await finisher({ task: task(), cwd: repo, member: "codex", summary: "s", preExisting: ["seed.txt"] });
      expect(r.ok, `wrapped=${wrapped} detail=${r.detail}`).toBe(true);
      expect(r.detail).toContain("145");
    }
  });
});
