/**
 * @aigility-harness/core — TaskProvider 统一任务契约（任务管理 provider 化）
 *
 * 架构决策(2026-10): 飞书任务清单 / Gitea 工单 / agentd 任务三源统一为
 * 「收集 + 实施」provider 模型:
 *   - 收集 provider (capabilities.collect): 飞书任务清单、群聊 pipeline、
 *     (未来) Jira / Linear / Slack 待办…
 *   - 实施 provider (capabilities.execute): agentd(codex 等编码工人)、
 *     真人实施(经 Gitea 工单认领)…
 *   - 双向 provider: Gitea 工单既收集(工单先行)也实施(真人认领/PR/自动关单)。
 *
 * UID 决策(2026-10): TaskRecord.uid 由 harness 自发号("tsk_" 前缀 UUID),
 * 不借用任何外部系统 ID:
 *   - 工单先行(Gitea-first/未来 Jira)的任务收集时可能尚无飞书任务,
 *     主键绑死飞书违反可插拔初衷;
 *   - 外部对象可被人在 SaaS 侧删除(飞书任务/工单), 主键不能寄生其上;
 *   - provider 平权: 新 provider 实现契约+注册即接入, 不存在号段迁移。
 * 出生地记在 origin(只写一次, 溯源用), 实施侧句柄记在 links(可变, 可并存),
 * 人类可读的标题前缀 "[org/repo#N]" 只作展示, 不再作为机器关联依据。
 */

import { randomUUID } from "node:crypto";

// ── 统一状态 ─────────────────────────────────────────────────────

/**
 * 统一任务状态。以 agentd 状态集为超集定义(它是执行态全家桶),
 * 飞书自定义分组 P/D/C/A 与 Gitea open/closed 都是本枚举的投影:
 *   planned↔飞书P · dispatched↔agentd pending_confirm/pending_project/queued ·
 *   running↔agentd running · review↔agentd needs_review/飞书C ·
 *   failed↔agentd failed/飞书A · done↔agentd completed+工单closed
 *   needs-input↔执行中暂停等人决策（2026-10-13 决策状态机；不算失败，
 *   完成决策后回到 running 同上下文续跑）
 */
export type UnifiedStatus =
  | "planned"
  | "ready"
  | "dispatched"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "suspended"
  | "blocked"
  | "needs-input"
  | "cancelled";

/** 合法状态转移表。主链单向: planned→ready→dispatched→running→review→done;
 *  验收打回(review→planned/ready)与失败重做(failed→ready)是仅有的回边。
 *  planned→review：工单在体外已完成（如 Gitea 直接关闭）的完成态同步。
 *  needs-input（2026-10-13 决策状态机）：running 派发中的工人遇方案分叉，
 *  写 .agent-decision.json 后暂停等人工决策；running→needs-input 暂停、
 *  needs-input→running 带决策结论续跑（同线程不重跑）、needs-input→ready
 *  为决策重入队（超时按默认项继续，重新认领）。卡片/提醒按 needs-input
 *  呈「A 待修复」同组（见 worker-team）。 */
export const TASK_STATUS_TRANSITIONS: Record<UnifiedStatus, UnifiedStatus[]> = {
  planned: ["ready", "review", "suspended", "cancelled"],
  ready: ["dispatched", "review", "planned", "suspended", "cancelled"],
  dispatched: ["running", "review", "ready", "suspended", "cancelled"],
  running: ["review", "done", "failed", "blocked", "needs-input", "suspended", "cancelled"],
  "needs-input": ["running", "ready", "failed", "suspended", "cancelled"],
  review: ["done", "failed", "ready", "planned", "suspended"],
  done: [],
  failed: ["ready", "suspended", "cancelled"],
  suspended: ["planned", "ready", "cancelled"],
  blocked: ["ready", "cancelled"],
  cancelled: [],
};

// ── 记录形态 ─────────────────────────────────────────────────────

/** 外部句柄: provider 侧指向外部对象的稳定标识 */
export interface ExternalHandle {
  /** provider 内唯一 ID(飞书任务 guid / Gitea "org/repo#N" / agentd taskId) */
  guid: string;
  /** 人类可点链接(飞书 applink / Gitea issue url) */
  url?: string;
}

/** 执行激活态：处于这两态的任务被 provider 独占，不得改派其它 provider */
export const ACTIVE_EXEC_STATUSES: UnifiedStatus[] = ["dispatched", "running"];

/** 统一任务记录(权威形态, TaskRegistry 存储) */
export interface TaskRecord {
  /** 全局主键: harness 发号 "tsk_" + UUID(见文件头 UID 决策) */
  uid: string;
  title: string;
  /** 需求描述原文/补齐后的全文（五要素检查单的现状/方法/目标判定对象） */
  description?: string;
  status: UnifiedStatus;
  /** 出生地(溯源, 写入后不变): 哪个 provider 的哪个对象演化出本记录 */
  origin: { provider: string } & ExternalHandle;
  /** 项目归属(org/repo), 归仓后回填 */
  projectRef?: string;
  /**
   * 结构化人员外键（人员台账 member_id，非显示名）：
   * 执行人/复核人在解析成功时写入，是「某人的任务」「谁批了什么」查询的主键；
   * 解析失败留空（原始文本仍在 description/review.by）。
   */
  assignee_member_id?: string;
  reviewer_member_id?: string;
  /** 实施侧句柄表: providerId → handle(飞书/工单/agentd 并存, 各记各的) */
  links: Record<string, ExternalHandle>;
  /**
   * 执行独占声明: 收集侧全任务对齐(多源收敛一条记录), 执行侧一个任务
   * 只交给一个 provider——claim() 原子写入, 转入 ready/planned/cancelled
   * 时自动清除(允许重新派发)。
   */
  assigned?: { provider: string; handle: string; at: number };
  /**
   * 放行/复核记录：via=auto 为五要素齐全自动放行（by=system）；
   * via=manual 为人工批准（补齐确认/低置信一票/看板按钮），by=复核人，
   * member_id=复核人的人员台账外键（解析成功时）。
   */
  review?: { by: string; via: "auto" | "manual"; at: number; note?: string; member_id?: string };
  /** 执行产出/失败摘要（执行方写：如 worker-team 派发结果） */
  note?: string;
  /**
   * 失败计数（2026-10-22）：D 侧 failed 归位 P 时 +1；P 侧自动放行按它设门槛——
   * failed 且 <2 自动重试一次，≥2 停止自动重放升级人工（防确定性失败无限循环刷屏）。
   */
  attempts?: { failed: number; lastError?: string; lastFailedAt?: number };
  /**
   * 派发基线快照（worker-team 写）：任务「首次派发」时工作区的既有改动文件清单。
   * 收尾判定「本轮有无新改动」时与它做差集。必须存在任务级字段而非每轮现拍：
   * 决策续跑（同线程第二轮）时上一轮的产物已落盘，现拍会把它们当「派发前已有」
   * 而误判「无新改动」→ 交付失败（2026-10-14 连续包月任务实证）。
   * 存文件名清单（非 HEAD sha）以兼容沙箱 .git 只读。
   */
  dispatchBase?: { at: number; files: string[] };
  createdAt: number;
  updatedAt: number;
}

/** provider 上报的事件(sync 流的最小单元) */
export interface TaskEvent {
  uid: string;
  /** 上报 provider */
  provider: string;
  at: number;
  /** 新状态(mapStatus 归一后); undefined 表示纯字段变更 */
  status?: UnifiedStatus;
  /** 人类可读说明(进审计/通知) */
  note?: string;
}

/** 执行句柄: execute() 受理后返回, 交给 sync() 轮询终态 */
export interface ExecutionHandle {
  uid: string;
  provider: string;
  /** provider 内部任务 ID(agentd taskId 等) */
  handle: string;
}

/** 收集游标(增量拉取断点, 实现自定义编码: 时间戳/page_token 均可) */
export interface TaskCursor {
  provider: string;
  value?: string;
}

/** collect provider 吐出的收编候选（uid/时间戳由 registry 发号，origin 按其去重） */
export interface CollectTaskInput {
  title: string;
  /** 描述原文（执行者标记/五要素判定的对象） */
  description?: string;
  /** 收集时的原生状态投影（仅首次收编生效，后续真值以 sync/transition 为准） */
  status?: UnifiedStatus;
  origin: { provider: string } & ExternalHandle;
  projectRef?: string;
  /**
   * 收集时已知的同体外部对象（如 agentd 任务的 sourceMessageId 反推出的
   * 工单句柄）。registry 收编时挂进 links；对已存在记录只补缺失的键。
   */
  related?: Record<string, ExternalHandle>;
}

// ── 契约: 可更换的任务 provider ──────────────────────────────────

/**
 * 任务 provider 契约。
 *
 * 实现约定:
 * - collect: 增量吐出收编候选 CollectTaskInput(游标断点续传); registry 按
 *   origin 去重并发号, provider 无需感知全局 uid。
 * - execute: 受理一条任务, 返回执行句柄; 不具备实施能力不实现此方法。
 * - sync: 按句柄流式上报事件; 状态一律过 mapStatus 归一, 不认识的
 *   原生状态返回 undefined 由上层兜底。
 * - 契约是主体, 插件是过客: 与 task-queue 同款可更换设计。
 */
export interface TaskProvider {
  /** provider ID(如 "feishu-task" / "gitea-issue" / "agentd"), 全局唯一 */
  id: string;
  capabilities: { collect: boolean; execute: boolean };
  /** 原生状态 → 统一状态; 不认识返回 undefined */
  mapStatus(native: string): UnifiedStatus | undefined;
  collect?(cursor?: TaskCursor): AsyncIterable<CollectTaskInput>;
  execute?(task: TaskRecord): Promise<ExecutionHandle | undefined>;
  sync?(handle: ExecutionHandle): AsyncIterable<TaskEvent>;
}

/** harness 发号: "tsk_" + UUID */
export function newTaskUid(): string {
  return `tsk_${randomUUID()}`;
}
