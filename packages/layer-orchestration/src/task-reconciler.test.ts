/**
 * task-reconciler 单测：标题即外键的重复收敛、执行独占异常巡检、
 * collect 集成、周期调度启停。全走假桩，不触网。
 */
import { describe, it, expect, vi } from "vitest";
import { alignOnce, createPeriodicAligner, issueGuidFromTitle } from "./task-reconciler.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskProvider, CollectTaskInput } from "@aigility-harness/core";

function stubProvider(id: string, items: CollectTaskInput[]): TaskProvider {
  return {
    id,
    capabilities: { collect: true, execute: false },
    mapStatus: () => undefined,
    collect: function* () {
      yield* items;
    } as never,
  };
}

describe("issueGuidFromTitle", () => {
  it("解析 [org/repo#N]，无标记返回 undefined", () => {
    expect(issueGuidFromTitle("[TiMEM-AI/timem_frontend#8] 优化图片")).toBe("TiMEM-AI/timem_frontend#8");
    expect(issueGuidFromTitle("[TiMEM-AI/timem_frontend] 无工单号")).toBeUndefined();
    expect(issueGuidFromTitle(undefined)).toBeUndefined();
  });
});

describe("alignOnce 定期对齐", () => {
  it("标题内嵌工单号的记录与工单句柄记录自动收敛为一条", async () => {
    const registry = new TaskRegistry();
    // gitea 工单先入册（执行锚点），飞书侧标题带 #25 的记录随后被收集
    const providers: TaskProvider[] = [
      stubProvider("gitea-issue", [
        { title: "VECTOR_MIN_SCORE 配置化", origin: { provider: "gitea-issue", guid: "org/repo#25" }, projectRef: "org/repo" },
      ]),
      stubProvider("feishu-task", [
        { title: "[org/repo#25] VECTOR_MIN_SCORE 配置化", origin: { provider: "feishu-task", guid: "f-25" } },
        { title: "无关任务", origin: { provider: "feishu-task", guid: "f-other" } },
      ]),
    ];

    const report = await alignOnce(registry, providers);
    expect(report.merged).toHaveLength(1);
    const keep = registry.findByExternal("gitea-issue", "org/repo#25")!;
    expect(registry.findByExternal("feishu-task", "f-25")?.uid).toBe(keep.uid); // 索引重指
    expect(keep.links["feishu-task"]?.guid).toBe("f-25");
    expect(registry.list()).toHaveLength(2); // 合并掉一条，剩 工单体+无关任务
    expect(registry.invariantViolations()).toEqual([]);
  });

  it("激活态无独占声明会被巡检报出（历史数据场景）", async () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "老链路派发", origin: { provider: "agentd-task", guid: "agt-x" } });
    registry.transition(r.uid, "ready");
    registry.transition(r.uid, "dispatched"); // 直接流转，未经 claim → 无 assigned

    const report = await alignOnce(registry, []);
    expect(report.exclusivity).toHaveLength(1);
    expect(report.exclusivity[0].uid).toBe(r.uid);
  });

  it("看板镜像态（飞书 D 组投影、无执行侧句柄）不报独占异常", async () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "飞书先行任务", origin: { provider: "feishu-task", guid: "f-mirror" } });
    registry.transition(r.uid, "dispatched"); // 收集器投影，agentd 未领取

    const report = await alignOnce(registry, []);
    expect(report.exclusivity).toHaveLength(0);
  });

  it("collect 统计随对齐一并返回", async () => {
    const registry = new TaskRegistry();
    const report = await alignOnce(registry, [
      stubProvider("feishu-task", [{ title: "新任务", origin: { provider: "feishu-task", guid: "f-new" } }]),
    ]);
    expect(report.collected.adoptedTotal).toBe(1);
    expect(report.merged).toHaveLength(0);
    expect(report.conflicts).toEqual([]);
  });
});

describe("createPeriodicAligner 调度", () => {
  it("runAtStart 立即执行，onReport 回调，stop 后不再跑", async () => {
    const registry = new TaskRegistry();
    const onReport = vi.fn();
    const aligner = createPeriodicAligner({
      registry,
      providers: [],
      intervalMs: 10,
      onReport,
      runAtStart: true,
    });
    aligner.start();
    expect(aligner.running()).toBe(true);
    await vi.waitFor(() => expect(onReport).toHaveBeenCalled(), { timeout: 500 });
    aligner.stop();
    expect(aligner.running()).toBe(false);
    const calls = onReport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(onReport.mock.calls.length).toBe(calls); // 停止后不再触发
  });
});
