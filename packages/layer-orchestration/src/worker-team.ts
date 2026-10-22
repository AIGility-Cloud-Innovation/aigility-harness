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
import { err, ok, PluginState, LayerId } from "@aigility-harness/core";
import type { Result, TaskRecord, Provider, ServiceDefinition, HealthStatus, SeamContext } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";
import { listChangedFiles } from "./pr-finisher.js";
import type { FinishInfo } from "./pr-finisher.js";
export type { FinishInfo };
import {
  DECISION_FILE,
  DECISION_RULES,
  readAgentDecision,
  writeDecision,
  isPendingDecision,
  hasConclusion,
  removeDecisionFile,
} from "./agent-decision.js";
export { DECISION_FILE, DECISION_RULES } from "./agent-decision.js";
export type { AgentDecision } from "./agent-decision.js";
// 统一执行人判定（单一真相）：人工执行人任务（负责人/描述标记）不被工人小组抢接
import { executorOfTask } from "./task-issue-sync.js";
// worktree 隔离（2026-10-14 修复）：决策文件在任务专属 worktree 里，续跑读决策
// 文件必须优先用 worktree 路径（派发侧 prepare 的对称面），否则读主仓库根必然落空
import { worktreeRoot, worktreeDirName } from "./worktree-manager.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 决策续跑的工作区解析：worktree 存在则用 worktree，否则回退主仓库根 */
function resolveDecisionCwd(repoRoot: string | undefined, uid: string): string | undefined {
  if (!repoRoot) return undefined;
  const wt = join(worktreeRoot(), worktreeDirName(repoRoot, uid));
  if (existsSync(wt)) return wt;
  return repoRoot;
}

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
  /** 擅长标签（分派路由能力匹配档；如 planning/refactor/docs/quick-fix/data） */
  strengths?: string[];
  /** 不擅长/禁用场景（能力匹配时跳过该成员） */
  weakAt?: string[];
}

/** 能力标签词表（pickWorker 关键词 → 标签的匹配规则） */
export const STRENGTH_KEYWORDS: Record<string, string[]> = {
  planning: ["方案", "设计", "架构", "评审", "规划", "plan", "design", "review"],
  refactor: ["重构", "清理", "优化", "refactor", "cleanup", "simplify"],
  docs: ["文档", "注释", "说明", "readme", "doc", "报告"],
  "quick-fix": ["修复", "修复", "小改", "fix", "bug", "补"],
  data: ["数据", "脚本", "报表", "统计", "sql", "csv", "excel"],
  web: ["网页", "页面", "前端", "html", "web", "页面"],
};

/** 能力路由（第 3 优先级）：按 description/title 关键词匹配成员擅长标签。
 *  默认特色（依据各 CLI 驱动器实测特性，2026-10-12 负责人确认）：
 *  - codex：均衡首选（planning 强——经 @cognitive 规划链路，复杂任务主选）
 *  - claude：文档/长文与 refactor 深改（长上下文、编辑质量稳）
 *  - zcode：quick-fix/轻量工程改动（启动快、成本低）
 *  - pi：data/脚本/批处理（print 模式、models.json 接网关，适合机械型任务） */
export function inferTaskTags(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(STRENGTH_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => lower.includes(k)))
    .map(([tag]) => tag);
}

/** 分派决策（第 3 功能：显式 > 项目绑定 > 能力匹配 > 兜底） */
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
  // 3) 能力匹配：任务关键词命中成员 strengths（weakAt 一票否决）
  const tags = inferTaskTags(`${task.description ?? ""} ${task.title}`);
  if (tags.length > 0) {
    const byStrength = roster.find(
      (w) =>
        !(w.weakAt ?? []).some((t) => tags.includes(t)) &&
        (w.strengths ?? []).some((t) => tags.includes(t)),
    );
    if (byStrength) return byStrength;
  }
  // 4) 默认兜底（名册第一位）
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
  /** 失败换人重派上限（缺省 0：失败即终态留现场——2026-10-13 拍板，业界惯例不换人重跑） */
  failoverLimit?: number;
  /**
   * 决策暂停机制（2026-10-13）：工人返回后若工作区出现 .agent-decision.json
   * （未决策）→ 转 needs-input 暂停等人工，不算失败；群内回复「决策 <任务号>
   * <选项>」写回结论 + 重入队（needs-input→running）后，由本组 reclaim
   * 用同线程 + 决策结论续跑（不重跑）。
   */
  decision?: {
    /** 机器人群播报函数（装配层注入；不注入则只记 note 不播报） */
    notify?: (text: string) => Promise<void> | void;
    /** needs-input 超时（ms）：到期未决策按默认项续跑或转 failed（缺省 24h） */
    timeoutMs?: number;
    /** 超时策略：default=按文件默认项续跑；failed=转 failed 终态（缺省 default） */
    onTimeout?: "default" | "failed";
  };
  /**
   * 宿主侧收尾器（2026-10-13 pr-finisher）：工人 ok 后由它建分支/提交/push/
   * 建 PR。交付成败以它为准（PR 建成才算 done），未注入则维持旧行为
   * （工人 ok 即 done——单测与无交付场景兼容）。
   */
  finish?: (info: FinishInfo) => Promise<{ ok: boolean; detail: string }>;
  /**
   * 派发前工作区准备（2026-10-13 worktree 隔离）：resolveCwd 解析出「仓库根」后，
   * 由此钩子产出「本任务专属工作目录」（通常是 worktree 路径）与所在分支，
   * 工人与收尾器都在该目录内作业。返回 ok:false 则放弃派发（不退回主仓库）。
   * 未注入则维持旧行为（直接在主仓库工作区干活）。
   */
  prepare?: (
    task: TaskRecord,
    repoRoot: string,
  ) => Promise<{ ok: true; cwd: string; branch: string } | { ok: false; error: string }>;
}

const DEFAULT_ROSTER: WorkerMember[] = [
  { id: "codex", serviceId: "@action/codex-agent", tier: "light" },
  { id: "claude", serviceId: "@action/claude-agent", tier: "light" },
  { id: "zcode", serviceId: "@action/zcode-agent", tier: "light" },
  { id: "pi", serviceId: "@action/pi-agent", tier: "light" },
];

/** 决策文件 options 下标兜底：非法/越界/缺省回落 0（首项=推荐项） */
function optionIndexOf(d: { options: string[]; defaultOption?: number }): number {
  const n = d.defaultOption;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < d.options.length ? n : 0;
}

/** 写回决策结论（静默版，超时兜底用）：失败打日志不抛 */
function writeDecisionQuiet(cwd: string, decision: string, opts: { decidedBy: string; decidedFrom: string }): void {
  const r = writeDecision(cwd, decision, opts);
  if (!r.ok) console.error(`[worker-team] 决策超时写回失败: ${r.error}`);
}

/** 派发前快照（无 cwd 返回空数组） */
async function preExistingOf(cwd: string | undefined): Promise<string[]> {
  return cwd ? listChangedFiles(cwd).catch(() => [] as string[]) : [];
}

/** 交付报告要求（2026-10-22 用户拍板）：最终输出=PR 正文「交付报告」节，读者是不了解过程的验收人 */
export const DELIVERY_REPORT_RULES = [
  "【交付报告要求（重要）】",
  "你的最终输出会原样进入 PR 描述，供不了解过程的人做验收决策，请严格用以下结构：",
  "## 改了什么",
  "  每个文件/模块一句话，用业务语言（不要过程流水账）。",
  "## 没动什么",
  "  边界与不变式（如「入账状态机未动」「仅新增可空列」）。",
  "## 怎么验证的",
  "  执行过的测试命令与结果原文；跳过的测试说明原因。",
  "## 已知风险/待验证",
  "  诚实列出未验证项（如真实数据质量、外部依赖可用性）。",
  "禁止把内部排障过程（工具报错、重试、输出截断）写进最终输出。",
].join("\n");

/** 沙箱边界提示（2026-10-13）：工人 CLI 在沙箱里断网且 .git 只读，git 写操作/push 必败 */
function boundaryLines(): string {
  return [
    "【执行边界（重要）】",
    "1. 你运行在沙箱内：无网络、.git 只读。禁止执行 git commit/push/branch 或任何网络操作（curl/pip/npm install 等）。",
    "2. 只做：读代码、修改文件、在沙箱内运行测试验证。",
    "3. 分支、提交、push、建 PR 由宿主侧收尾器在完成后统一处理，你无需关心。",
    "4. 测试命令尽量离线可用（pytest 本地用例等）；若必须联网装依赖则跳过并说明。",
  ].join("\n");
}

/** 决策播报文案（结构化：任务号+问题+选项+推荐；机器人群一条消息决策） */
export function decisionBroadcast(
  uid: string,
  d: { question: string; context?: string; options: string[]; defaultOption?: number },
  itemNo = 1,
): string {
  const rec = d.defaultOption ?? 0;
  const lines = [
    `🧭 任务 ${uid}（决策 ${itemNo}）需要你拍板`,
    `问题：${d.question}`,
    ...(d.context ? [`背景：${d.context.split("\n").slice(0, 4).join(" ").slice(0, 200)}`] : []),
    ...d.options.map((o, i) => `  ${i === rec ? "★" : " "} ${i + 1}. ${o}${i === rec ? "（推荐）" : ""}`),
    ``,
    `回复「决策 ${itemNo} ${rec + 1}」即按推荐项继续；或「决策 ${itemNo} <选项序号/文字>」。`,
    `超时未回复将自动按推荐续跑。`,
  ];
  return lines.join("\n");
}

/** needs-input 超时解析（决策配置缺省 24h，不可用返回 undefined=不启用） */
function decisionTimeoutMs(o: NonNullable<WorkerTeamOptions["decision"]>): number | undefined {
  const n = o.timeoutMs ?? 24 * 3600_000;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class WorkerTeam {
  private readonly roster: WorkerMember[];
  private readonly o: WorkerTeamOptions;
  /** 防重：同 uid 只跑一次 */
  private readonly dispatched = new Set<string>();

  constructor(options: WorkerTeamOptions, roster: WorkerMember[] = DEFAULT_ROSTER) {
    this.o = options;
    this.roster = roster;
  }

  /**
   * 重启孤儿回收（2026-10-20）：上一进程死于 dispatched→running 之间的任务
   * 重启后无人认领（takeReady 只认 ready），永久滞留 dispatched。
   * 启动期一次性把 dispatched（无存活工人进程可查，统一视为孤儿）打回 ready 重认领。
   * running 已有工人会话，不在回收范围（人工接管）。
   */
  recoverOrphans(): number {
    const orphans = this.o.registry.list({ status: ["dispatched"] });
    let n = 0;
    for (const t of orphans) {
      const back = this.o.registry.transition(t.uid, "ready", "dispatched");
      if (back.ok) n++;
      else console.error(`[worker-team] 孤儿回收失败 ${t.uid}: ${back.error}`);
    }
    if (n > 0) console.log(`[worker-team] 重启孤儿回收：${n} 条 dispatched 打回 ready 重新认领`);
    return n;
  }

  /** 接单：扫台账 ready 队列并逐个派发（供 cron/调度循环调用） */
  async takeReady(limit = 5): Promise<Array<{ uid: string; result: Result<string> }>> {
    const ready = this.o.registry
      .list({ status: ["ready"] })
      .filter((t) => !this.dispatched.has(t.uid))
      // 人工任务不接（2026-10-10 铁律的认领侧防线）：带负责人/描述执行人标记的
      // ready 任务留给对应人（派发护栏同源判定），agent 任务才进工人小组。
      .filter((t) => executorOfTask({ description: t.description, assignee_member_id: t.assignee_member_id }) === undefined)
      .slice(0, limit);
    const results: Array<{ uid: string; result: Result<string> }> = [];
    for (const t of ready) {
      results.push({ uid: t.uid, result: await this.dispatch(t) });
    }
    return results;
  }

  /** 分派 + 派发 + 回流（单任务全流程） */
  async dispatch(task: TaskRecord): Promise<Result<string>> {
    if (task.status === "needs-input") {
      // 决策续跑专用入口：决策重入队（needs-input→ready）后由本方法/takeReady 续跑
      return this.resumeDecisionTask(task);
    }
    // 决策续跑（2026-10-13 修复）：决策人回复后状态被 reenqueueNeedsInput 转为 ready，
    // 此时 dispatch 走的是普通派发分支——若工作区存在「已写回结论」的决策文件，
    // 应改走续跑路径（同线程 + 结论注入），否则会话被当首轮重跑、结论丢失。
    if (task.status === "ready" && task.projectRef) {
      const probeRoot = this.o.resolveCwd?.(task.projectRef);
      const probeCwd = probeRoot ? resolveDecisionCwd(probeRoot, task.uid) : undefined;
      if (probeCwd) {
        const pending = readAgentDecision(probeCwd);
        if (hasConclusion(pending)) return this.resumeDecisionTask(task);
      }
    }
    if (this.dispatched.has(task.uid)) return err(`任务 ${task.uid} 已在执行/已派发`);
    const member = pickWorker(task, this.roster);
    if (!member) return err("名册中无可用成员（或显式指定的成员不存在）");

    const repoRoot = task.projectRef ? this.o.resolveCwd?.(task.projectRef) : undefined;
    // worktree 隔离（2026-10-13 事故修复）：有 prepare 钩子且解析到仓库根时，
    // 先建/复用「任务专属 worktree」，把 cwd 换成 worktree 路径再派发；
    // 失败则放弃派发（绝不退回主仓库——那正是两次 stash 冲突事故的来源）。
    let cwd = repoRoot;
    let preparedBranch: string | undefined;
    if (repoRoot && this.o.prepare) {
      const p = await this.o.prepare(task, repoRoot);
      if (!p.ok) {
        this.dispatched.delete(task.uid);
        // 失败即终态（2026-10-13 拍板，2026-10-20 补执行）：prep 失败落 cancelled，
        // 否则任务停在 ready，每拍重烧同一次失败（实测：worktree 残留分支中文报错→无限重试）。
        this.o.registry.transition(task.uid, "cancelled", "ready");
        this.o.registry.update(task.uid, { note: `工作区准备失败（终态，重跑请改标题重新放行）：${String(p.error).slice(0, 200)}` });
        return err(`工作区准备失败（worktree，已落 cancelled 终态）：${p.error}`);
      }
      cwd = p.cwd;
      preparedBranch = p.branch;
    }
    // 沙箱边界提示（2026-10-13）：工人 CLI 在沙箱里断网且 .git 只读，git 写操作/
    // push 必败。只管编码+测试，git 与 PR 由宿主侧收尾器统一完成。
    const boundary = boundaryLines();
    const timeoutMs = this.o.defaultTimeoutMs ?? 30 * 60_000;
    // 失败即终态（2026-10-13 拍板）：不换人重跑（烧 token 且产出混杂），留现场等人接管
    const failoverLimit = this.o.failoverLimit ?? 0;

    // 首次派发防重只在进入本流程前判（决策重入不受 dispatched 阻隔）
    this.dispatched.add(task.uid);

    // ── 首次派发：ready → claim → running → 调工人 ──
    const claimed = this.o.registry.claim(task.uid, `worker-team/${member.id}`, cwd ?? ".", "ready");
    if (!claimed.ok) {
      this.dispatched.delete(task.uid);
      return err(`台账领取失败：${claimed.error}`);
    }
    this.o.registry.transition(task.uid, "running", "dispatched");
    // 派发基线（2026-10-14 修复）：首轮拍一次并存进台账，决策续跑复用同一基线。
    // 续跑轮禁止现拍——上一轮产物已落盘，现拍会把它们当「派发前已有」→ 误判无新改动。
    const preExisting = await preExistingOf(cwd);
    this.o.registry.get(task.uid)!.dispatchBase = { at: Date.now(), files: preExisting };
    const prompt = `${boundary}\n\n---\n${DECISION_RULES}\n\n---\n${DELIVERY_REPORT_RULES}\n\n---\n${(task.description ?? task.title).replace(/\[worker:\w+\]\s*/, "")}`;
    const r = await this.o.callWorker(member, { prompt, cwd, timeoutMs } satisfies AgentCallArgs);
    return await this.handleRunResult(task, member, cwd, r, preExisting, { resumed: false, ...(preparedBranch ? { branch: preparedBranch } : {}) });
  }

  /**
   * 决策续跑（2026-10-13）：needs-input → 决策已写回 → 同一线程 + 结论续跑。
   * 原会话不重跑（codex exec resume <threadId>），worker 拿到 injected_decision 继续。
   */
  private async resumeDecisionTask(task: TaskRecord): Promise<Result<string>> {
    if (this.dispatched.has(task.uid)) {
      return err(`任务 ${task.uid} 已在执行/已派发`);
    }
    const member = pickWorker(task, this.roster);
    if (!member) return err("名册中无可用成员（或显式指定的成员不存在）");
    // worktree 隔离（2026-10-14 修复）：决策文件写在任务专属 worktree（派发时 prepare
    // 换入的 cwd），续跑读决策文件必须解析 worktree 路径；无 worktree（旧任务）回退主仓库
    const repoRoot = task.projectRef ? this.o.resolveCwd?.(task.projectRef) : undefined;
    const cwd = repoRoot ? resolveDecisionCwd(repoRoot, task.uid)
                         : (task.assigned?.handle as string | undefined);
    if (!cwd) {
      this.o.registry.transition(task.uid, "failed", "needs-input");
      this.o.registry.get(task.uid)!.note = `[worker-team] 决策重入异常：无法定位工作区（${task.projectRef ?? "无 projectRef"}）`;
      return err("决策重入异常：无法定位工作区");
    }
    const d = readAgentDecision(cwd);
    if (isPendingDecision(d)) {
      return err(`任务 ${task.uid} 的决策文件尚未写回结论（需先在群内回复「决策」指令）`);
    }
    if (!hasConclusion(d)) {
      this.o.registry.transition(task.uid, "failed", "needs-input");
      this.o.registry.get(task.uid)!.note = `[worker-team] 决策重入异常：决策文件缺失或非法`;
      return err("决策重入异常：决策文件缺失或非法");
    }
    const concl = d.decision.decision;
    const timeoutMs = this.o.defaultTimeoutMs ?? 30 * 60_000;
    // 状态转移（2026-10-13 修复）：本方法有两个入口——needs-input 直入、
    // 以及「决策已写回后重入队为 ready」的派发路径。用当前状态作为 from，
    // 避免在 ready 入口下 from=needs-input 不匹配而使转移静默失效（卡在 ready）。
    const fromStatus = this.o.registry.get(task.uid)?.status ?? "needs-input";
    if (fromStatus === "ready") this.o.registry.transition(task.uid, "dispatched", "ready");
    this.o.registry.transition(task.uid, "running", fromStatus === "ready" ? "dispatched" : fromStatus);
    this.o.registry.get(task.uid)!.note = `[worker-team/${member.id}] 决策已拍板（${d.decision.decidedBy ?? "用户"}），续跑同一线程…`;
    this.dispatched.add(task.uid);
    const r = await this.o.callWorker(member, {
      prompt: `${boundaryLines()}\n\n---\n${DELIVERY_REPORT_RULES}\n\n---\n决策续跑：${concl}`,
      cwd,
      timeoutMs,
    } satisfies AgentCallArgs);
    removeDecisionFile(cwd);
    this.dispatched.delete(task.uid);
    // 基线复用（2026-10-14 修复）：续跑轮必须用首轮存在台账里的 dispatchBase，
    // 不能现拍——上一轮产物已落盘，现拍会把它们当「派发前已有」而误判「无新改动」，
    // 导致只在一轮产出、续跑轮不再改文件的任务交付失败（连续包月任务实证）。
    // 旧任务无 dispatchBase（本字段引入前派发）→ 退回现拍，行为同修复前。
    const preExisting = task.dispatchBase?.files ?? (await preExistingOf(cwd));
    return await this.handleRunResult(task, member, cwd, r, preExisting, { resumed: true });
  }

  /** 工人返回后的统一回流：决策暂停 / 完成收尾 / 失败终态 */
  private async handleRunResult(
    task: TaskRecord,
    member: WorkerMember,
    cwd: string | undefined,
    r: { ok: boolean; text: string; error?: string },
    preExisting: string[],
    opts: { resumed: boolean; branch?: string },
  ): Promise<Result<string>> {
    // ── ① 决策暂停（2026-10-13）：工人正常结束但工作区出现未决策文件 →
    //      转 needs-input（不算失败，不计 failover），机器人群播报决策请求
    if (r.ok && cwd) {
      const d = readAgentDecision(cwd);
      const req = isPendingDecision(d) && d.decision ? d.decision : undefined;
      if (req) {
        const timeoutMs = this.o.decision?.timeoutMs ?? 24 * 3600_000;
        this.o.registry.transition(task.uid, "needs-input", "running");
        this.o.registry.get(task.uid)!.note =
          `[worker-team/${member.id}] 需人工决策：「${req.question.slice(0, 60)}」` +
          `（决策文件 ${DECISION_FILE}，${opts.resumed ? "续跑轮" : "首轮"}待到 ${new Date(Date.now() + timeoutMs).toISOString()}）`;
        const text = decisionBroadcast(task.uid, req);
        try {
          await this.o.decision?.notify?.(text);
        } catch (e) {
          console.error(`[worker-team] 决策播报失败: ${String((e as Error)?.message ?? e)}`);
        }
        this.dispatched.delete(task.uid);
        return ok(`[${member.id}] 已暂停，等待人工决策（任务 ${task.uid}，见群播报）`);
      }
    }

    if (!r.ok) {
      // ── 失败即终态（不换人重跑）；除 decision 外现场保留 ──
      // 注意：resume 续跑失败时运行态已由 resumeDecisionTask 转入 running，
      // handleRunResult 只见 running（首次派发也是 running）→ from 恒 running
      const lastError = r.error ?? "unknown";
      this.o.registry.transition(task.uid, "failed", "running");
      this.o.registry.get(task.uid)!.note = `[worker-team/${member.id}] 失败：${lastError.slice(0, 300)}`;
      this.dispatched.delete(task.uid);
      return err(`[${member.id}] 执行失败 → ${lastError}`);
    }

    // ── ② 收尾：未装配收尾器 = 工人 ok 即 done（单测/无交付场景兼容）──
    const note = `[worker-team/${member.id}] ${r.text.slice(0, 300)}`;
    if (!this.o.finish) {
      this.o.registry.transition(task.uid, "done", "running");
      this.o.registry.get(task.uid)!.note = note;
      this.dispatched.delete(task.uid);
      return ok(`[${member.id}] ${r.text.slice(0, 200)}`);
    }

    const fin = await this.o.finish({
      task, cwd, member: member.id, summary: r.text, preExisting,
      ...(opts.branch ? { branch: opts.branch } : {}),
    });
    if (fin.ok) {
      // PR 交付语义（2026-10-13 负责人拍板）：agent 任务终结于 PR——建成才转 review
      // （待验收），done 留给飞书人工点完成/验收闭环；note 携 PR 链接，
      // 对齐器 pr-board-sync 据此把卡片挪「C 待测试」。
      this.o.registry.transition(task.uid, "review", "running");
      this.o.registry.get(task.uid)!.note =
        `[worker-team/${member.id}] ${r.text.slice(0, 160)}${fin.detail ? ` | ${fin.detail}` : ""}`.slice(0, 300);
      this.dispatched.delete(task.uid);
      return ok(`[${member.id}] ${fin.detail || r.text.slice(0, 200)}`);
    }

    // ── 收尾失败：failed 终态留现场（不换人重跑）──
    this.o.registry.transition(task.uid, "failed", "running");
    this.o.registry.get(task.uid)!.note = `[worker-team/${member.id}] 交付失败：${fin.detail.slice(0, 300)}`;
    this.dispatched.delete(task.uid);
    return err(`[${member.id}] 收尾失败 → ${fin.detail}`);
  }

  /**
   * 决策超时扫（循环节拍调用）：needs-input 逾期 → 按配置用默认项续跑或转 failed。
   * 返回本轮兜底的任务 uid 列表（供日志）。
   */
  async settleExpiredDecisions(now = Date.now()): Promise<string[]> {
    const decision = this.o.decision;
    if (!decision) return [];
    const timeoutMs = decisionTimeoutMs(decision);
    if (!timeoutMs) return [];
    const out: string[] = [];
    for (const t of this.o.registry.list({ status: ["needs-input"] })) {
      const since = t.updatedAt ?? t.createdAt;
      if (now - since < timeoutMs) continue;
      const cwd = t.projectRef ? this.o.resolveCwd?.(t.projectRef) : undefined;
      if (!cwd) {
        this.o.registry.transition(t.uid, "failed", "needs-input");
        this.o.registry.get(t.uid)!.note = `[worker-team] 决策超时（${timeoutMs}ms）但无法定位工作区，转 failed`;
        out.push(t.uid);
        continue;
      }
      const d = readAgentDecision(cwd);
      const req = isPendingDecision(d) && d.decision ? d.decision : undefined;
      if (decision.onTimeout === "failed" || !req) {
        this.o.registry.transition(t.uid, "failed", "needs-input");
        this.o.registry.get(t.uid)!.note =
          `[worker-team] 决策超时（${timeoutMs}ms）${req ? "" : "且决策文件异常"}，转 failed 留现场`;
        out.push(t.uid);
        continue;
      }
      // 默认项续跑（2026-10-13）：按 options[defaultOption=0] 拍板，会重新派发续跑
      const dflt = req.options[optionIndexOf(req)];
      writeDecisionQuiet(cwd, dflt, { decidedBy: "system", decidedFrom: "决策超时自动按默认项" });
      const enq = this.o.registry.reenqueueNeedsInput(t.uid);
      if (enq.ok) {
        this.o.registry.get(t.uid)!.note = `[worker-team] 决策超时（${timeoutMs}ms），按默认项「${dflt}」自动续跑`;
        this.o.decision?.notify?.(
          `⏱️ [决策超时] ${(t.title ?? "").slice(0, 40)}（尾号 ${t.uid.slice(-6)}）已按默认项「${dflt}」自动续跑；如需改判请回复「决策 ${t.uid.slice(-6)} 选项」`,
        );
        out.push(t.uid);
      } else {
        // 重入队失败（并发/状态已变）→ 本拍跳过，下拍再判；记录错误便于诊断
        console.warn(`[worker-team] 决策超时重入队失败 ${t.uid}（${enq.error}），本拍跳过`);
      }
    }
    return out;
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
