/**
 * worker-team 单测（P0）：分派路由（显式/项目绑定/兜底/指定不存在成员）、
 * 换人重派、状态回流（claim→running→done/failed + note 摘要）、防重派发。
 * registry 用真实 TaskRegistry（内存模式）做端到端状态验证。
 */
import { describe, it, expect } from "vitest";
import { TaskRegistry } from "./task-registry.js";
import { WorkerTeam, pickWorker, inferTaskTags } from "./worker-team.js";
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
