/**
 * worker-team — 工人小组（编排域多工人接单/分派/执行/回流服务）
 *
 * 2026-10-12 负责人命名与定位：
 *   主人格（唯一对用户形象）→ 工人小组（她带的班组）→ 工人（干活的）。
 *   本服务是小组本体（D4 编排域）；组员执行在 D3 行动域（@action/*-agent 与
 *   agentd 重型成员——闸门/审计/加密上下文仍在 agentd 自身，见 timem-project 拍板）。
 *
 * P0 最小实现（本文件）：接单 → 分派 → 派发执行 → 监督（超时）→ 状态回流。
 *   - 接单：从 TaskRegistry 领取 ready 任务（claim 原子领取，协议复用 core）；
 *   - 分派：任务显式指定 worker > 项目绑定 > 默认 codex（failover 换人重派）；
 *   - 执行：经 ctx 调 @action/{codex,claude,zcode,pi}-agent（四工人 prompt/cwd/
 *     timeoutMs 公共面已证兼容），cwd = projectRef 解析出的仓库根；
 *   - 回流：终态写回台账（done/failed + 产出摘要），状态映射单点在本组。
 *
 * P1/P2（不在本期）：验收判定接 G1-5、队列与并发上限、组状态板、YAML
 * dispatch_node 节点化、崩溃后重启恢复。
 */
import { err, ok, PluginState } from "@aigility-harness/core";
import type { Result, TaskRecord, Provider, ServiceDefinition, HealthStatus } from "@aigility-harness/core";
import { LayerId } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";

/** 小组成员登记（P0 硬编码名册；P1 配置化） */
export interface WorkerMember {
  /** 成员 id = 对应 @action 服务短名 */
  id: "codex" | "claude" | "zcode" | "pi";
  /** D3 行动域服务契约 */
  serviceId: `@action/${string}-agent`;
  /** 该成员可承载的任务分级：light=即发型；heavy=需 agentd 闸门型（P0 拒接） */
  tier: "light";
  /** 项目 shortName → 优先用此成员（分派路由第 2 优先级） */
  projectAffinity?: string[];
}

/** 分派决策（第 3 功能 P0 形态） */
export function pickWorker(
  task: TaskRecord,
  roster: WorkerMember[],
): WorkerMember | null {
  const shortName = task.projectRef?.split("/").pop() ?? "";
  // 1) 显式指定（description 里 [worker:xxx] 标记）
  const m = /\[worker:(\w+)\]/.exec(task.description ?? "");
  const wanted = m?.[1];
  if (wanted) {
    const hit = roster.find((w) => w.id === wanted);
    if (!hit) return null; // 指定了不存在的成员 → 直接失败，不静默换人
    return hit;
  }
  // 2) 项目绑定
  const byAffinity = roster.find((w) => w.projectAffinity?.includes(shortName));
  if (byAffinity) return byAffinity;
  // 3) 默认兜底（名册第一位）
  return roster[0] ?? null;
}

/** 派发输入（组员统一调用面；四工人 Request 公共面） */
export interface DispatchInput {
  taskUid: string;
  member: WorkerMember;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
}

/** P0 调用面假设：四工人 provider 请求公共字段（prompt/cwd/timeoutMs） */
type AgentCallArgs = { prompt: string; cwd?: string; timeoutMs?: number };

export interface WorkerTeamOptions {
  registry: TaskRegistry;
  /** 台账 projectRef（org/repo）→ 本机仓库根目录 */
  resolveCwd?: (projectRef: string) => string | undefined;
  /** 成员调用器（装配层注入：包 @action provider 的 ctx.call） */
  callWorker: (member: WorkerMember, args: AgentCallArgs) => Promise<{ ok: boolean; text: string; error?: string }>;
  /** 单成员派发超时（缺省 15 分钟） */
  defaultTimeoutMs?: number;
  /** 失败换人重派上限（缺省 1：主成员失败换兜底重试一次） */
  failoverLimit?: number;
}

const DEFAULT_ROSTER: WorkerMember[] = [
  { id: "codex", serviceId: "@action/codex-agent", tier: "light" },
  { id: "claude", serviceId: "@action/claude-agent", tier: "light" },
  { id: "zcode", serviceId: "@action/zcode-agent", tier: "light" },
  { id: "pi", serviceId: "@action/pi-agent", tier: "light" },
];

export class WorkerTeam {
  private readonly roster: WorkerMember[];
  private readonly o: WorkerTeamOptions;
  /** 防重：同 uid 只跑一次 */
  private readonly dispatched = new Set<string>();

  constructor(options: WorkerTeamOptions, roster: WorkerMember[] = DEFAULT_ROSTER) {
    this.o = options;
    this.roster = roster;
  }

  /** 接单：扫台账 ready 队列并逐个派发（供 cron/调度循环调用） */
  async takeReady(limit = 5): Promise<Array<{ uid: string; result: Result<string> }>> {
    const ready = this.o.registry
      .list({ status: ["ready"] })
      .filter((t) => !this.dispatched.has(t.uid))
      .slice(0, limit);
    const results: Array<{ uid: string; result: Result<string> }> = [];
    for (const t of ready) {
      results.push({ uid: t.uid, result: await this.dispatch(t) });
    }
    return results;
  }

  /** 分派 + 派发 + 回流（单任务全流程） */
  async dispatch(task: TaskRecord): Promise<Result<string>> {
    if (this.dispatched.has(task.uid)) return err(`任务 ${task.uid} 已在执行/已派发`);
    const member = pickWorker(task, this.roster);
    if (!member) return err("名册中无可用成员（或显式指定的成员不存在）");

    const cwd = task.projectRef ? this.o.resolveCwd?.(task.projectRef) : undefined;
    const prompt = (task.description ?? task.title).replace(/\[worker:\w+\]\s*/, "");
    const timeoutMs = this.o.defaultTimeoutMs ?? 15 * 60_000;
    const failoverLimit = this.o.failoverLimit ?? 1;

    this.dispatched.add(task.uid);
    // 台账 claim：ready → running（原子，改派保护在 claim 内）
    const claimed = this.o.registry.claim(task.uid, `worker-team/${member.id}`, cwd ?? ".", "ready");
    if (!claimed.ok) {
      this.dispatched.delete(task.uid);
      return err(`台账领取失败：${claimed.error}`);
    }

    // 派发（含换人重派）。claim 后任务为 dispatched；开工转 running，
    // 终态 running→done/failed（core 转移表）。产出摘要记入 record.note。
    const memberErrors: string[] = [];
    let current = member;
    this.o.registry.transition(task.uid, "running", "dispatched");
    for (let attempt = 0; attempt <= failoverLimit; attempt++) {
      const r = await this.o.callWorker(current, { prompt, cwd, timeoutMs } satisfies AgentCallArgs);
      if (r.ok) {
        this.o.registry.transition(task.uid, "done", "running");
        this.o.registry.get(task.uid)!.note = `[worker-team/${current.id}] ${r.text.slice(0, 300)}`;
        return ok(`[${current.id}] ${r.text.slice(0, 200)}`);
      }
      memberErrors.push(`${current.id}: ${r.error ?? "unknown"}`);
      // 换人：换名册里下一个不同成员（成员间失败切换不回写台账，终态统一记因）
      const next = this.roster.find((w) => w.id !== current.id && w.tier === "light");
      if (!next) break;
      current = next;
    }
    // 回流：终态 failed + 各成员失败原因聚合
    const lastError = memberErrors.join("；");
    this.o.registry.transition(task.uid, "failed", "running");
    this.o.registry.get(task.uid)!.note = `[worker-team] 失败：${lastError.slice(0, 300)}`;
    return err(`全部尝试失败 → ${lastError}`);
  }
}

/** 服务定义（编排域） */
export const workerTeamService: ServiceDefinition<void, void> = {
  id: "@orchestration/worker-team",
  version: "0.1.0",
  layer: LayerId.Orchestration,
  description: "工人小组：多工人接单/分派/执行监督/状态回流（P0：ready 队列→claim→调 @action 工人→终态回台账）",
};

export const workerTeamProvider: Provider<void, void> = {
  service: workerTeamService,
  name: "orchestration-worker-team",
  state: PluginState.Active,
  async execute(_req: void) {
    return ok(undefined);
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "worker-team ready（工人小组 P0：接单/分派/派发/回流）",
      checkedAt: new Date().toISOString(),
    };
  },
};
