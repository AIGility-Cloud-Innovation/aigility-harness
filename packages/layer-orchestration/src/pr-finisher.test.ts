import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWrongRepoDelivery,
  titleOfRepo,
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

const wrongRepoPrUrl = "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/pulls/271";

describe("isWrongRepoDelivery", () => {
  it("标题归属与 PR 仓库不一致时判错仓，同仓不误判", () => {
    expect(isWrongRepoDelivery("【timem_console_frontend】修复页面", wrongRepoPrUrl)).toBe(true);
    expect(isWrongRepoDelivery("【timem-platform-backend】修复接口", wrongRepoPrUrl)).toBe(false);
    expect(titleOfRepo("[TiMEM-AI/TiMEM_Console-Frontend] 修复页面")).toBe("TiMEM-AI/TiMEM_Console-Frontend");
  });
  it("组合标题【agent】[org/repo] 取仓库括号，不取角色词（2026-10-26 同仓误判回归）", () => {
    expect(titleOfRepo("【agent】[TiMEM-AI/timem-platform-backend] 修复接口")).toBe("TiMEM-AI/timem-platform-backend");
    expect(isWrongRepoDelivery("【agent】[TiMEM-AI/timem-platform-backend] 修复接口", wrongRepoPrUrl)).toBe(false);
    expect(isWrongRepoDelivery("【agent】[TiMEM-AI/timem_console_frontend] 修复页面", wrongRepoPrUrl)).toBe(true);
    expect(isWrongRepoDelivery("【agent】[AIGility-Cloud-Innovation/aigility-harness] 修 bug", wrongRepoPrUrl)).toBe(true);
  });
  it("角色词/中文前缀不算归属：不猜，不判错仓", () => {
    expect(titleOfRepo("【agent】修复接口")).toBeUndefined();
    expect(titleOfRepo("【待安排执行者】timem console 费用明细导出功能")).toBeUndefined();
    expect(isWrongRepoDelivery("【待安排执行者】timem console 费用明细导出功能", wrongRepoPrUrl)).toBe(false);
  });
});

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

  // 2026-10-14 回归：git 默认 core.quotePath=true 会把中文路径转义成 \346\212\200 并加双引号，
  // 回传给 git add 必失败（agent 交付在最后一步全灭）。双保险：调用侧带 -c core.quotePath=false，
  // 解析侧再兜底还原（decodeGitPath），确保两种情况都拿到真实 UTF-8 路径。
  it("中文路径未转义时原样透传", () => {
    const out = "?? .ai/_plan/技术方案/2026-10-14-01-子社区方案说明.md";
    expect(parsePorcelain(out)).toEqual([".ai/_plan/技术方案/2026-10-14-01-子社区方案说明.md"]);
  });

  it("中文路径被转义时兜底还原（bug 现场形态）", () => {
    // 这是 bug 现场的真实字节形态；修复后必须还原成同名真实路径，否则 git add 必失败
    const escaped = '?? ".ai/_plan/\\346\\212\\200\\346\\234\\257\\346\\226\\271\\346\\241\\210/x.md"';
    expect(parsePorcelain(escaped)).toEqual([".ai/_plan/技术方案/x.md"]);
  });

  it("rename 的转义路径同样还原", () => {
    const out = 'R  "a/\\346\\227\\247.txt" -> "b/\\346\\226\\260.txt"';
    expect(parsePorcelain(out)).toEqual(["b/新.txt"]);
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

describe("buildPrBody / buildCommitMessage", () => {
  it("交付报告结构化（2026-10-22）：含改了什么/没动什么标题位，4000 字不截腰", () => {
    const long = Array.from({ length: 40 }, (_, i) => `第${i}行说明内容填充行`).join("\n");
    const body = buildPrBody(task(), "codex", ["app/a.py"], long);
    expect(body).toContain("### 交付报告");
    expect(body).not.toContain("工人摘要");
    expect(body).toContain("第39行说明内容填充行"); // 4000 字内不截
  });
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
  it("标题带 [#N] 且归属一致 → PR 正文含 Closes 自动关单（2026-10-20 拍板）", () => {
    const t = task({ title: "【agent】[TiMEM-AI/timem-platform-backend#53] 修复白屏" });
    const body = buildPrBody(t, "codex", ["a.py"], "完成");
    expect(body).toContain("Closes #53");
  });
  it("标题 [#N] 但归属他仓 → 不写 Closes（防误关）", () => {
    const t = task({ title: "[TiMEM-AI/other-repo#53] 修复白屏", projectRef: "TiMEM-AI/timem-platform-backend" });
    expect(buildPrBody(t, "codex", ["a.py"], "完成")).not.toContain("Closes #");
  });
});

describe("detectBaseBranch", () => {
  it("无 origin/HEAD 回退 main（不抛）", async () => {
    // 用一个必然失败的 cwd（不存在目录）——execFile 抛错被 catch 后回退 main
    await expect(detectBaseBranch("/nonexistent-pr-finisher-test")).resolves.toBe("main");
  });

  // 2026-10-26 事故回归：收尾时 cwd 在 agent 分支上，旧实现回退「当前分支」
  // → merge-base refs/remotes/origin/agent/<...>「Not a valid object name」整轮判失败。
  it("origin/HEAD 缺失 + 当前分支为 agent/* → 不返回 agent 分支，回退真实存在的 origin/main", async () => {
    const { execSync } = await import("node:child_process");
    const base = mkdtempSync(join(tmpdir(), "detect-base-agent-"));
    const bare = join(base, "origin.git");
    const repo = join(base, "repo");
    execSync(`git init --bare "${bare}"`, { stdio: "ignore" });
    execSync(`git init -b main "${repo}"`, { stdio: "ignore" });
    execSync(
      `git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t && ` +
        `git -C "${repo}" remote add origin "${bare}"`,
      { stdio: "ignore" },
    );
    execSync(`git -C "${repo}" commit -m init --allow-empty --no-verify`, { stdio: "ignore" });
    execSync(`git -C "${repo}" push -u origin main`, { stdio: "ignore" });
    // 删掉 origin/HEAD，复现事故当天状态
    try { execSync(`git -C "${repo}" symbolic-ref --delete refs/remotes/origin/HEAD`, { stdio: "ignore" }); } catch { /* 未设置 */ }
    // 切到 agent 分支（本地生成、未 push → 远端无此引用）
    execSync(`git -C "${repo}" checkout -b agent/t102044-t102128-cce8fe`, { stdio: "ignore" });

    const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
    delete process.env["WORKER_TEAM_BASE_BRANCH"];
    try {
      const got = await detectBaseBranch(repo);
      expect(got).toBe("main");
      // 旧实现会返回 agent/t102044-t102128-cce8fe → 该引用远端不存在 → merge-base 必炸
      expect(got).not.toContain("agent/");
      // 新基线可用：merge-base 不再抛错
      execSync(`git -C "${repo}" merge-base HEAD refs/remotes/origin/${got}`, { stdio: "ignore" });
    } finally {
      if (saved !== undefined) process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
    }
  });

  it("env WORKER_TEAM_BASE_BRANCH 显式优先（覆盖探测）", async () => {
    const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
    process.env["WORKER_TEAM_BASE_BRANCH"] = "release/2026";
    try {
      await expect(detectBaseBranch("/nonexistent-pr-finisher-test")).resolves.toBe("release/2026");
    } finally {
      if (saved === undefined) delete process.env["WORKER_TEAM_BASE_BRANCH"];
      else process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
    }
  });

  // 2026-10-27 P0：探测级联轨迹——归因要看到「每一级探测了什么、成没成」才能定位根因
  it("探测级联记录每级结果（缺失 origin/HEAD 时如实记，不猜）", async () => {
    const { detectBaseBranchWithTrace } = await import("./pr-finisher.js");
    const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
    delete process.env["WORKER_TEAM_BASE_BRANCH"];
    try {
      const { branch, trace } = await detectBaseBranchWithTrace("/nonexistent-pr-finisher-test");
      expect(branch).toBe("main");
      expect(trace).toContain("WORKER_TEAM_BASE_BRANCH 未设置");
      expect(trace).toContain("origin/HEAD");
      expect(trace).toContain("refs/remotes/origin/main");
    } finally {
      if (saved !== undefined) process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
    }
  });

  // 2026-10-27 P0：证据必须点破「agent 分支远端不存在 = 收尾器基线选取缺陷，
  // 不是权限/网络问题」——这正是旧归因误判的根因
  it("诊断证据点破 agent 分支无远程引用，且明确不是权限/网络问题", async () => {
    const { execSync } = await import("node:child_process");
    const { buildBaselineEvidence } = await import("./pr-finisher.js");
    const base = mkdtempSync(join(tmpdir(), "baseline-evidence-"));
    const bare = join(base, "origin.git");
    const repo = join(base, "repo");
    execSync(`git init --bare "${bare}"`, { stdio: "ignore" });
    execSync(`git init -b main "${repo}"`, { stdio: "ignore" });
    execSync(
      `git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t && ` +
        `git -C "${repo}" remote add origin "${bare}"`,
      { stdio: "ignore" },
    );
    execSync(`git -C "${repo}" commit -m init --allow-empty --no-verify`, { stdio: "ignore" });
    execSync(`git -C "${repo}" push -u origin main`, { stdio: "ignore" });
    try { execSync(`git -C "${repo}" symbolic-ref --delete refs/remotes/origin/HEAD`, { stdio: "ignore" }); } catch { /* 未设置 */ }
    execSync(`git -C "${repo}" checkout -b agent/t102044-t102128-cce8fe`, { stdio: "ignore" });

    const saved = process.env["WORKER_TEAM_BASE_BRANCH"];
    delete process.env["WORKER_TEAM_BASE_BRANCH"];
    try {
      const ev = await buildBaselineEvidence(repo);
      expect(ev).toContain("agent/t102044-t102128-cce8fe");       // 记下当前分支
      expect(ev).toContain("**不存在**");                          // 点破关键事实
      expect(ev).toContain("收尾器基线选取缺陷");                   // 正确归因方向
      expect(ev).toContain("不是仓库权限问题");                     // 明确排除误判方向
      expect(ev).toContain("未提交改动文件数");                     // 附带「工人是否落盘」事实
    } finally {
      if (saved !== undefined) process.env["WORKER_TEAM_BASE_BRANCH"] = saved;
    }
  });
});

describe("createPrFinisher", () => {
  it("错仓 PR → failed，不触发 PingCode 副作用", async () => {
    const { execSync } = await import("node:child_process");
    const base = mkdtempSync(join(tmpdir(), "pr-finisher-wrong-repo-"));
    const repo = join(base, "repo");
    execSync(
      `git init --bare "${base}/origin.git" && git init -b main "${repo}" && ${""}` +
      `git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t && git -C "${repo}" remote add origin "${base}/origin.git"`,
      { stdio: "ignore" },
    );
    // stash push 需要 unborn HEAD 之外的真实基线，先落一个初始提交并推到裸远端（供 checkout origin/main）
    execSync(`git -C "${repo}" add -A && git -C "${repo}" commit -m init --no-verify --allow-empty && git -C "${repo}" push -u origin main`, { stdio: "ignore" });
    execSync("echo changed > changed.txt", { cwd: repo, stdio: "ignore" });

    let pingcodeCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      pingcodeCalled = true;
      throw new Error("PingCode must not be called");
    }) as typeof fetch;
    try {
      const finisher = createPrFinisher({
        giteaCall: async () => ({
          ok: true,
          value: { status: 201, data: { ok: true, data: { number: 271, html_url: wrongRepoPrUrl } } },
        }),
        baseBranch: "main",
      });
      const r = await finisher({
        task: task({ title: "【timem_console_frontend】修复页面", projectRef: "TiMEM-AI/timem-platform-backend" }),
        cwd: repo,
        member: "codex",
        summary: "错仓交付回归",
        preExisting: [],
      });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain("错仓：PR 在 timem-platform-backend");
      expect(r.detail).toContain("卡归属 timem_console_frontend");
      expect(pingcodeCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("建 PR 成功 → ok + PR 链接（走注入的 giteaCall；git 操作注入空目录）", async () => {
    const giteaCall = async (req: Record<string, unknown>) => {
      expect(req.method).toBe("POST");
      expect(req.path).toBe("/api/v1/repos/TiMEM-AI/timem-platform-backend/pulls");
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
