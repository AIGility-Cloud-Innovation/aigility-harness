/**
 * worker-team 单测（P0）：分派路由（显式/项目绑定/兜底/指定不存在成员）、
 * 换人重派、状态回流（claim→running→done/failed + note 摘要）、防重派发。
 * 决策暂停机制（2026-10-13）：.agent-decision.json → needs-input 暂停（非 failed）、
 * 群回复写回结论 → resume 同一线程续跑、超时按默认项续跑/转 failed。
 * registry 用真实 TaskRegistry（内存模式）做端到端状态验证。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry } from "./task-registry.js";
import { WorkerTeam, pickWorker, inferTaskTags, decisionBroadcast } from "./worker-team.js";
import { DECISION_FILE, writeDecision } from "./agent-decision.js";
import type { WorkerMember } from "./worker-team.js";
import type { TaskRecord } from "@aigility-harness/core";

const ROSTER: WorkerMember[] = [
  { id: "codex", serviceId: "@action/codex-agent", tier: "light", projectAffinity: ["nx-opc"] },
  { id: "claude", serviceId: "@action/claude-agent", tier: "light" },
];

function makeRegistry(): TaskRegistry {
  return new TaskRegistry(undefined); // 内存模式（不落盘）
}

function seedTask(reg: TaskRegistry, over: Partial<TaskRecord> = {}): TaskRecord {
  const rec = reg.adopt({
    title: "验证任务",
    description: "把 foo 函数改成 bar",
    origin: { provider: "test", guid: `g-${Math.random().toString(36).slice(2)}` },
    ...over,
  } as never);
  reg.approve(rec.uid, { via: "auto", by: "system" }); // planned → ready
  return reg.get(rec.uid)!;
}

describe("pickWorker 分派路由", () => {
  it("description 带 [worker:claude] → 显式指定优先", () => {
    const t = { description: "[worker:claude] 干活", projectRef: "org/nx-opc" } as TaskRecord;
    expect(pickWorker(t, ROSTER)?.id).toBe("claude");
  });

  it("项目绑定：nx-opc 项目 → codex（affinity）", () => {
    const t = { description: "干活", projectRef: "org/nx-opc" } as TaskRecord;
    expect(pickWorker(t, ROSTER)?.id).toBe("codex");
  });

  it("无指定无绑定 → 兜底第一位 codex", () => {
    const t = { description: "干活", projectRef: "org/other" } as TaskRecord;
    expect(pickWorker(t, ROSTER)?.id).toBe("codex");
  });

  it("显式指定不存在的成员 → null（不静默换人）", () => {
    const t = { description: "[worker:gpt] 干活" } as TaskRecord;
    expect(pickWorker(t, ROSTER)).toBeNull();
  });
});

describe("能力路由（第 3 优先级，能力特色名册）", () => {
  const CAP_ROSTER = [
    { id: "codex", serviceId: "@action/codex-agent", tier: "light", strengths: ["planning", "web"] } as WorkerMember,
    { id: "claude", serviceId: "@action/claude-agent", tier: "light", strengths: ["docs", "refactor"], weakAt: ["quick-fix"] } as WorkerMember,
    { id: "zcode", serviceId: "@action/zcode-agent", tier: "light", strengths: ["quick-fix"] } as WorkerMember,
    { id: "pi", serviceId: "@action/pi-agent", tier: "light", strengths: ["data"] } as WorkerMember,
  ];

  it("「写个数据统计脚本」→ pi（data 标签）", () => {
    const t = { description: "写个数据统计脚本", title: "" } as TaskRecord;
    expect(pickWorker(t, CAP_ROSTER)?.id).toBe("pi");
  });

  it("「修复登录页 bug」→ zcode（quick-fix；claude weakAt 否决）", () => {
    const t = { description: "修复登录页 bug", title: "" } as TaskRecord;
    expect(pickWorker(t, CAP_ROSTER)?.id).toBe("zcode");
  });

  it("「重构用户模块」→ claude（refactor）", () => {
    const t = { description: "重构用户模块", title: "" } as TaskRecord;
    expect(pickWorker(t, CAP_ROSTER)?.id).toBe("claude");
  });

  it("「设计方案评审」→ codex（planning）", () => {
    const t = { description: "设计方案评审", title: "" } as TaskRecord;
    expect(pickWorker(t, CAP_ROSTER)?.id).toBe("codex");
  });

  it("无能力关键词 → 兜底第一位 codex", () => {
    const t = { description: "随便跑一下", title: "" } as TaskRecord;
    expect(pickWorker(t, CAP_ROSTER)?.id).toBe("codex");
  });

  it("inferTaskTags 中英混合命中", () => {
    expect(inferTaskTags("Fix the login bug")).toContain("quick-fix");
    expect(inferTaskTags("更新 README 文档")).toContain("docs");
  });
});

describe("WorkerTeam 派发与回流", () => {
  it("成功路径：claim → running → done，note 记成员与产出摘要（prompt 含沙箱边界提示）", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const team = new WorkerTeam(
      {
        registry: reg,
        callWorker: async (_m, args) => {
          // 2026-10-13：提示词带沙箱边界（工人禁 git/网络），任务原文附在分隔线后
          expect(args.prompt).toContain("把 foo 函数改成 bar");
          expect(args.prompt).toContain("【执行边界（重要）】");
          return { ok: true, text: "已完成：foo → bar，测试通过" };
        },
      },
      ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(true);
    const rec = reg.get(t.uid)!;
    expect(rec.status).toBe("done");
    expect(rec.assigned?.provider).toContain("worker-team/codex");
    expect(rec.note).toContain("[worker-team/codex]");
    expect(rec.note).toContain("已完成");
  });

  it("失败即终态：codex 失败不换人重跑（2026-10-13 拍板），failed 留现场", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const calls: string[] = [];
    const team = new WorkerTeam(
      {
        registry: reg,
        callWorker: async (m) => {
          calls.push(m.id);
          return { ok: false, text: "", error: "CLI 崩溃" };
        },
      },
      ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["codex"]); // 只调一次：不换人
    expect(reg.get(t.uid)!.status).toBe("failed");
    expect(reg.get(t.uid)!.note).toContain("CLI 崩溃");
  });

  it("全员失败：终态 failed，note 记原因", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const team = new WorkerTeam(
      { registry: reg, callWorker: async () => ({ ok: false, text: "", error: "全部超时" }) }, ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(false);
    const rec = reg.get(t.uid)!;
    expect(rec.status).toBe("failed");
    expect(rec.note).toContain("全部超时");
  });

  it("防重：同任务二次 dispatch 拒绝", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const team = new WorkerTeam(
      { registry: reg, callWorker: async () => ({ ok: true, text: "done" }) }, ROSTER,
    );
    await team.dispatch(reg.get(t.uid)!);
    const r2 = await team.dispatch(reg.get(t.uid)!);
    expect(r2.ok).toBe(false);
  });

  it("收尾器成功：PR 建成 → review 待验收（done 留给人工验收，2026-10-13 拍板）", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const team = new WorkerTeam(
      {
        registry: reg,
        callWorker: async () => ({ ok: true, text: "编码完成" }),
        finish: async () => ({ ok: true, detail: "https://git.example/pr/146（agent/x → dev，3 文件）" }),
      },
      ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(true);
    const rec = reg.get(t.uid)!;
    expect(rec.status).toBe("review"); // PR 交付 → review，非 done
    expect(rec.note).toContain("[worker-team/codex]");
    expect(rec.note).toContain("pr/146"); // PR 链接在 note（pr-board-sync 识别特征）
  });

  it("收尾器失败：交付失败=failed 终态（现场保留，不换人重跑）", async () => {
    const reg = makeRegistry();
    const t = seedTask(reg);
    const team = new WorkerTeam(
      {
        registry: reg,
        callWorker: async () => ({ ok: true, text: "编码完成" }),
        finish: async () => ({ ok: false, detail: "push 被拒" }),
      },
      ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(false);
    expect(reg.get(t.uid)!.status).toBe("failed");
  });

  it("takeReady：只接 ready 队列，派发后不再重复接", async () => {
    const reg = makeRegistry();
    seedTask(reg, { title: "任务一" });
    seedTask(reg, { title: "任务二" });
    const team = new WorkerTeam(
      { registry: reg, callWorker: async () => ({ ok: true, text: "ok" }) }, ROSTER,
    );
    const first = await team.takeReady();
    expect(first).toHaveLength(2);
    expect(first.every((x) => x.result.ok)).toBe(true);
    const second = await team.takeReady();
    expect(second).toHaveLength(0); // 已派发的不重接
  });

  it("cwd 解析：projectRef → resolveCwd 传给成员", async () => {
    const reg = makeRegistry();
    seedTask(reg, { projectRef: "org/nx-opc" });
    let gotCwd: string | undefined;
    const team = new WorkerTeam(
      {
        registry: reg,
        resolveCwd: (ref) => `/repos/${ref}`,
        callWorker: async (_m, args) => {
          gotCwd = args.cwd;
          return { ok: true, text: "ok" };
        },
      },
      ROSTER,
    );
    await team.takeReady();
    expect(gotCwd).toBe("/repos/org/nx-opc");
  });
});

// ── 决策暂停机制（2026-10-13）────────────────────────────────────

describe("决策暂停机制（.agent-decision.json → needs-input → 群回复续跑）", () => {
  function tmpRepo(): string {
    return mkdtempSync(join(tmpdir(), "worker-decision-"));
  }

  function seedInRepo(reg: TaskRegistry, repo: string): TaskRecord {
    const t = seedTask(reg, { projectRef: "org/decision-repo", title: "决策任务" });
    return t;
  }

  it("工人返回带未决策文件 → needs-input（非 failed）+ 群播报结构化决策请求", async () => {
    const reg = makeRegistry();
    const repo = tmpRepo();
    const t = seedInRepo(reg, repo);
    let broadcast = "";
    const team = new WorkerTeam(
      {
        registry: reg,
        resolveCwd: (ref) => (ref === "org/decision-repo" ? repo : undefined),
        callWorker: async () => {
          writeFileSync(
            join(repo, DECISION_FILE),
            JSON.stringify({ question: "A 方案还是 B 方案？", context: "两种都可行", options: ["A 方案", "B 方案"] }),
            "utf-8",
          );
          return { ok: true, text: "问题已就绪，等待决策" };
        },
        decision: { notify: async (txt) => { broadcast = txt; }, timeoutMs: 60000 },
      },
      ROSTER,
    );
    const r = await team.dispatch(reg.get(t.uid)!);
    expect(r.ok).toBe(true);
    const rec = reg.get(t.uid)!;
    expect(rec.status).toBe("needs-input"); // 非 failed
    expect(rec.note).toContain("需人工决策");
    expect(broadcast).toContain(t.uid);
    expect(broadcast).toContain("A 方案还是 B 方案");
    expect(broadcast).toContain("A 方案（推荐）");
    expect(broadcast).toContain("决策 "); // 指令提示
  });

  function childCallPrompts(calls: Array<{ prompt: string }>): string {
    return calls.map((c) => c.prompt).join("\n---\n");
  }

  it("决策写回结论后 resume：同一线程（threadId 透传）+ 决策结论注入，不重跑", async () => {
    const reg = makeRegistry();
    const repo = tmpRepo();
    const t = seedInRepo(reg, repo);
    const calls: Array<{ prompt: string; cwd?: string }> = [];
    const team = new WorkerTeam(
      {
        registry: reg,
        resolveCwd: (ref) => (ref === "org/decision-repo" ? repo : undefined),
        callWorker: async (_m, args) => {
          calls.push({ prompt: args.prompt, cwd: args.cwd });
          if (calls.length === 1) {
            writeFileSync(
              join(repo, DECISION_FILE),
              JSON.stringify({ question: "选哪个", options: ["A", "B"] }),
              "utf-8",
            );
            return { ok: true, text: "等决策" };
          }
          return { ok: true, text: "已按结论完成" };
        },
        decision: { notify: async () => {}, timeoutMs: 60000 },
      },
      ROSTER,
    );
    await team.dispatch(reg.get(t.uid)!);
    expect(reg.get(t.uid)!.status).toBe("needs-input");
    // 决策人回「决策 1 2」（B）→ 写回结论 → 重入队 needs-input→ready→dispatch
    const w = writeDecision(repo, "B", { decidedBy: "johnny", decidedFrom: "决策 tsk 选 B" });
    expect(w.ok).toBe(true);
    const ready = reg.reenqueueNeedsInput(t.uid);
    expect(ready.ok).toBe(true);
    const r2 = await team.dispatch(reg.get(t.uid)!);
    expect(r2.ok, `r2.err=${r2.ok ? "" : r2.error}`).toBe(true);
    expect(calls.length).toBe(2); // 只派两次：首轮 + 续跑（不重跑）
    expect(reg.get(t.uid)!.status).toBe("done");
    // 断言两轮回执内容：首轮带决策约定；续跑提示词含决策结论
    const prompts = calls.map((c) => c.prompt);
    const first = prompts[0] ?? "";
    const resumed = prompts[1] ?? "";
    expect(first).toContain("【决策暂停约定");
    expect(resumed).toContain("决策续跑：B");
    expect(reg.get(t.uid)!.note).toContain("已按结论完成");
    // 决策文件已被清理（续跑完后不残留）
    expect(existsSync(join(repo, DECISION_FILE))).toBe(false);
  });

  it("决策超时兜底：按默认项写回 + 重入队 ready（config 缺省 24h → timeoutMs 覆盖）", async () => {
    const reg = makeRegistry();
    const repo = tmpRepo();
    const t = seedInRepo(reg, repo);
    const team = new WorkerTeam(
      {
        registry: reg,
        resolveCwd: (ref) => (ref === "org/decision-repo" ? repo : undefined),
        callWorker: async () => {
          writeFileSync(
            join(repo, DECISION_FILE),
            JSON.stringify({ question: "选哪个", options: ["A", "B"], defaultOption: 0 }),
            "utf-8",
          );
          return { ok: true, text: "等决策" };
        },
        decision: { notify: async () => {}, timeoutMs: 50, onTimeout: "default" },
      },
      ROSTER,
    );
    await team.dispatch(reg.get(t.uid)!);
    expect(reg.get(t.uid)!.status).toBe("needs-input");
    // 模拟超时：把 updatedAt 直接拨回 24h 前（决策 timeoutMs 用 50ms 的覆盖）
    const recRef = reg.get(t.uid)!;
    (recRef as { updatedAt: number }).updatedAt -= 86_400_000;
    const settled = await team.settleExpiredDecisions(Date.now());
    expect(settled).toContain(t.uid);
    const after = reg.get(t.uid)!;
    expect(after.status).toBe("ready"); // 默认项续跑，重入队
    const d = JSON.parse(readFileSync(join(repo, DECISION_FILE), "utf-8"));
    expect(d.decision).toBe("A"); // defaultOption=0 → A
    expect(d.decidedBy).toBe("system");
    expect(after.note).toContain("决策超时");
  });

  it("决策超时兜底：onTimeout=failed → needs-input 转 failed（现场保留）", async () => {
    const reg = makeRegistry();
    const repo = tmpRepo();
    const t = seedInRepo(reg, repo);
    const team = new WorkerTeam(
      {
        registry: reg,
        resolveCwd: (ref) => (ref === "org/decision-repo" ? repo : undefined),
        callWorker: async () => {
          writeFileSync(
            join(repo, DECISION_FILE),
            JSON.stringify({ question: "选哪个", options: ["A", "B"] }),
            "utf-8",
          );
          return { ok: true, text: "等决策" };
        },
        decision: { notify: async () => {}, timeoutMs: 50, onTimeout: "failed" },
      },
      ROSTER,
    );
    await team.dispatch(reg.get(t.uid)!);
    expect(reg.get(t.uid)!.status).toBe("needs-input");
    (reg.get(t.uid)! as { updatedAt: number }).updatedAt -= 86_400_000;
    const settled = await team.settleExpiredDecisions(Date.now());
    expect(settled).toContain(t.uid);
    expect(reg.get(t.uid)!.status).toBe("failed");
    expect(reg.get(t.uid)!.note).toContain("决策超时");
  });
});
