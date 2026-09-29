/**
 * L4 编排规划层: task-pipeline — 群聊 → 任务 → 工单 → PR 提醒 流水线
 *
 * 定时流程（每 tick）：
 *   1. 取出监听缓冲里的群聊消息（D1 feishu-ingress passive 模式喂入）
 *   2. 调 @cognitive/llm-inference 判定：哪些是待执行任务（标题/优先级/仓库）
 *   3. 与 Gitea 各仓库 open 工单 + 飞书任务查重（词集 Jaccard 相似度）
 *   4. 新任务 → 飞书先行（默认）：先建飞书任务挂 org 清单「P 计划中」，
 *      归属+执行者齐备后由 plan-gate 回填建 Gitea 工单（TASK_FEISHU_FIRST=0
 *      回到旧链路：汇总即建工单，标题前缀 [P0-P3]）→ 群播报
 *   5. 轮询各仓库 open PR → 发现新 PR → 群提醒真人合并
 *
 * 只管理，不执行：本服务不写代码，执行由 codex 系工人/真人完成。
 *
 * LLM 判定容错：LLM 不可用时消息保留在缓冲（有上限），下个 tick 重试。
 * 状态（已见 PR、缓冲）存 ctx.getState，重启后 PR 会重新提醒一次，可接受。
 */

import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// ── 消费引用 ─────────────────────────────────────────────────────

export const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};
export const feishuApiRef: CapabilityRef = {
  id: "@action/feishu-api",
  versionRange: "^1.0.0",
};
export const giteaApiRef: CapabilityRef = {
  id: "@action/gitea-api",
  versionRange: "^1.0.0",
};

/** 消费同层编排域的双建同步原语（工单→飞书任务，与 persona 共用单一真相） */
export const taskIssueSyncRef: CapabilityRef = {
  id: "@orchestration/task-issue-sync",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface TaskPipelineRequest {
  /** 汇总周期毫秒，默认 600000（10 分钟）；作为兜底 tick 间隔（PR 轮询等） */
  intervalMs?: number;
  /**
   * 静默自动汇总窗口 ms（quiet window 防抖）：最后一条免@消息静默满此时长即触发
   * 汇总，不等固定 tick。默认 env TIMEM_QUIET_SUMMARIZE_MS，再退 600000。
   */
  quietMs?: number;
  /** 单批最多送给 LLM 的消息条数，默认 40 */
  maxBatch?: number;
  /** 缓冲上限（LLM 不可用时防无限膨胀），默认 200 */
  bufferLimit?: number;
  /** 监听的 Gitea 仓库（owner/name），兜底池与 PR 轮询范围 */
  repos: string[];
  /**
   * 群 → 候选仓库池（来源群 = 任务归属参考）：
   *   - 池内 1 个仓库 → 汇总任务直接归属该仓库（确定性，不再让 LLM 挑）
   *   - 池内多个仓库 → LLM 按内容挑选 + 置信标注，判不动进「群内澄清」队列
   *   - 未映射的参与群 → 用所有已映射池的并集；完全无映射 → repos 兜底
   * 装配层经 parseChatRepoMap(TASK_CHAT_REPO_MAP) 解析注入
   */
  chatRepoMap?: Record<string, string[]>;
  /** 群播报目标会话（chatId）；未设则不播报，仅建单 */
  notifyChatId?: string;
  /** 查重相似度阈值，默认 0.5 */
  dedupThreshold?: number;
  /** 判定用模型名，默认读 env TASK_PIPELINE_MODEL，再退 "qwen-turbo" */
  model?: string;
  /** 立即执行一次 tick（默认 true，方便启动即验证） */
  runOnStart?: boolean;
}

export interface TaskPipelineResponse {
  ok: boolean;
  intervalMs: number;
  /** 静默自动汇总窗口 ms（实际生效值） */
  quietMs?: number;
  /** 停止流水线 */
  stop: () => void;
}

export const taskPipelineService: ServiceDefinition<TaskPipelineRequest, TaskPipelineResponse> = {
  id: "@orchestration/task-pipeline",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "群聊监听汇总 → LLM 判定任务 → Gitea 工单去重入库 → PR 轮询群提醒（只管理不执行）",
};

// ── 监听缓冲（装配层喂入） ────────────────────────────────────────

export interface CollectedMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  ts: number;
}

const buffer: CollectedMessage[] = [];

/** 最后一条静默收集消息的时间戳（静默窗口锚点，防抖用） */
let lastCollectTs = 0;

/** 供测试/装配层读取静默锚点 */
export function lastCollectAnchor(): number {
  return lastCollectTs;
}

/** 装配层把 ingress passive 收集的消息推入缓冲 */
export function collectMessage(m: CollectedMessage): void {
  buffer.push(m);
  lastCollectTs = Date.now();
}

/**
 * 静默窗口调度判定（导出供单测）：
 * - 缓冲有消息且距最后一条收集已静默 quietMs → 触发汇总（quiet window 防抖：
 *   讨论进行中不打断，停嘴后尽快汇总，而非干等固定 tick）
 * - 否则距上次 tick 满 intervalMs → 兜底触发（保 PR 轮询等周期性职责）
 */
export function shouldFireTick(s: {
  bufferLen: number;
  now: number;
  lastCollectTs: number;
  lastRunTs: number;
  quietMs: number;
  intervalMs: number;
}): boolean {
  if (s.bufferLen > 0 && s.now - s.lastCollectTs >= s.quietMs) return true;
  return s.now - s.lastRunTs >= s.intervalMs;
}

/** 静默自动汇总窗口 ms：env TIMEM_QUIET_SUMMARIZE_MS 可覆盖，默认 10 分钟 */
export function defaultQuietMs(): number {
  const v = Number(process.env["TIMEM_QUIET_SUMMARIZE_MS"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/** 仅供测试：清空缓冲 */
export function clearBuffer(): void {
  buffer.length = 0;
}

// ── 纯函数（导出供单测） ─────────────────────────────────────────

/** 归一化标题：小写、去标点符号、压空白 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 词集 Jaccard 相似度；中文无空格分词，统一用字符二元组（含中英混合）；任一为空返回 0 */
export function jaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = normalizeTitle(s).replace(/ /g, "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (t.length === 1) set.add(t);
    return set;
  };
  const sa = grams(a);
  const sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface CandidateTask {
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  repo?: string;
  /** 多候选仓库池时 LLM 的归属置信标注（单仓池不需要；缺省视为 true） */
  confident?: boolean;
  reason?: string;
  /** 候选依据的原始消息编号（对应判定输入的 [1..n]），用于把话题上下文回填进工单正文 */
  sources?: number[];
}

/** 从 LLM 文本响应中解析 JSON 数组（容忍 ```json 包裹与前后闲话） */
export function parseCandidateTasks(text: string): CandidateTask[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as Array<Record<string, unknown>>;
    const valid = new Set(["P0", "P1", "P2", "P3"]);
    return arr
      .filter((o) => typeof o.title === "string" && (o.title as string).trim())
      .map((o) => ({
        title: String(o.title).trim().slice(0, 120),
        priority: (valid.has(String(o.priority)) ? String(o.priority) : "P2") as CandidateTask["priority"],
        repo: typeof o.repo === "string" && o.repo ? o.repo : undefined,
        confident: typeof o.confident === "boolean" ? o.confident : undefined,
        reason: typeof o.reason === "string" ? o.reason : undefined,
        sources: Array.isArray(o.sources)
          ? o.sources.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
          : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * 生成「原始讨论」引用块：引用 LLM 标注的原始消息（sources 编号）原文，
 * 无 sources 时退化为全部消息（截 5 条），保证工单自带讨论上下文而非空壳。
 */
export function quoteDiscussion(texts: string[] | undefined, sources: number[] | undefined): string {
  if (!texts || texts.length === 0) return "";
  const idx = sources && sources.length > 0
    ? sources.map((n) => n - 1).filter((i) => i >= 0 && i < texts.length)
    : texts.map((_, i) => i);
  const quoted = idx.slice(0, 5).map((i) => `> ${texts[i].replace(/\n/g, "\n> ")}`.slice(0, 500));
  return quoted.length > 0 ? `## 原始讨论\n\n${quoted.join("\n>\n")}\n` : "";
}

/**
 * 组装带话题上下文的工单正文（自动汇总直落建单用）。
 */
export function buildIssueBody(
  reason: string | undefined,
  texts: string[] | undefined,
  sources: number[] | undefined,
  chatId: string,
): string {
  const discussion = quoteDiscussion(texts, sources);
  return (
    `> 来源：飞书群聊自动汇总（${new Date().toISOString()}）\n` +
    `>\n` +
    `> 判定依据：${reason ?? "LLM 判定为待执行任务"}\n` +
    `> 来源群：${chatId === "*" ? "未知" : chatId}\n` +
    (discussion ? `\n${discussion}\n` : "\n") +
    `\n由 @orchestration/task-pipeline 自动创建，请负责人认领。`
  );
}

/** 判定 prompt（system + user 消息体） */
export function buildJudgeMessages(
  texts: string[],
  repos: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        `你是研发团队的群聊任务整理员。给定一批群聊消息，判断哪些包含"需要开发的任务/需求/bug"。\n` +
        `只输出一个纯 JSON 数组，禁止输出任何其他文字、解释或 markdown 代码块。\n` +
        `数组每项格式：{"title":"任务标题(简洁动宾短语)","priority":"P0|P1|P2|P3","repo":"归属仓库","confident":true,"reason":"一句话依据","sources":[1,3]}\n` +
        `准入标准（必须同时满足才输出）：\n` +
        `- 有明确的行动诉求：要求修改/新增/修复/排查某个具体对象，或报告了具体 bug/异常\n` +
        `- 有可指派的产出：做完后能被验证（页面行为、接口结果、文档产出等）\n` +
        `排除清单（命中任一 → 不输出该消息，宁漏勿滥，#25 误报根因）：\n` +
        `- 报告/汇报/总结/公告/周报/审查结论类：陈述已发生的事实或结论，未提出修改请求（如"安全审查报告""测试通过""上线完成"）\n` +
        `- 状态同步与进度通报（"已拉取代码""正在排查中"）\n` +
        `- 纯讨论/征求意见/闲聊/寒暄，无人提出行动要求\n` +
        `- 通知/转发/会议纪要，其中没有具体待办\n` +
        `其余规则：\n` +
        `- 同一主题的多条消息合并为一项，sources 填该主题涉及的全部消息编号\n` +
        `- P0=线上事故, P1=紧急重要, P2=一般需求, P3=低优\n` +
        `- 输出示例：[{"title":"修复登录页白屏","priority":"P1","repo":"${repos[0] ?? "TiMEM-AI/TiMEM-Space"}","confident":true,"reason":"明确报告了线上bug"}]\n` +
        `repo 字段只能从以下列表中原样选择：${repos.join(", ")}\n` +
        `归属仓库有多个候选时，依据消息内容判断；判断依据不充分、拿不准时 confident 填 false（宁可交人工确认，不要乱猜），有明确指向才填 true。`,
    },
    {
      role: "user",
      content: texts.map((t, i) => `[${i + 1}] ${t}`).join("\n"),
    },
  ];
}

/** 从一批候选里去掉与已有标题重复的（阈值以上视为重复） */
export function filterDuplicates(
  candidates: CandidateTask[],
  existingTitles: string[],
  threshold: number,
): CandidateTask[] {
  return candidates.filter((c) => {
    const dup = existingTitles.find((t) => jaccard(t, c.title) >= threshold);
    return !dup;
  });
}

// ── 群 → 候选仓库池（来源群 = 任务归属参考，跨群串单修复的核心） ──

/**
 * 解析 TASK_CHAT_REPO_MAP：条目逗号/换行分隔，`chatId=仓库1|仓库2`；
 * `org:组织名` 表示该组织下全部可访问仓库（判定时动态展开，10 分钟缓存）。
 */
export function parseChatRepoMap(raw: string | undefined): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const entry of (raw ?? "").split(/[,，\n]/)) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq <= 0) continue;
    const chatId = e.slice(0, eq).trim();
    const pool = e
      .slice(eq + 1)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chatId && pool.length > 0) map[chatId] = pool;
  }
  return map;
}

/** 群消息按来源群分桶（跨群消息绝不混批判定——历史上混批正是串单根因），无 chatId 归 "*" 桶 */
export function groupByChat<M extends { chatId?: string }>(msgs: M[]): Map<string, M[]> {
  const byChat = new Map<string, M[]>();
  for (const m of msgs) {
    const key = m.chatId || "*";
    const list = byChat.get(key);
    if (list) list.push(m);
    else byChat.set(key, [m]);
  }
  return byChat;
}

/**
 * 归属判定（导出供单测）：返回仓库 full_name，undefined = 需群内澄清。
 * 单仓池直接定仓（确定性，LLM 无权选仓）；多仓池要求 LLM 命中候选且未标
 * confident=false——历史上"缺省落 repos[0]"的静默兜底是跨群串单的放大器，
 * 这里改为宁问不猜。
 */
export function assignRepoForPool(c: CandidateTask, pool: string[]): string | undefined {
  if (pool.length === 1) return pool[0];
  if (c.repo && pool.includes(c.repo) && c.confident !== false) return c.repo;
  return undefined;
}

/** token 可访问的活跃仓库（org: 池展开用；10 分钟进程内缓存） */
let repoListCache: { repos: string[]; ts: number } | null = null;

async function listAccessibleRepos(ctx: SeamContext): Promise<string[]> {
  if (repoListCache && Date.now() - repoListCache.ts < 600_000) return repoListCache.repos;
  const r = (await ctx.call(giteaApiRef, {
    method: "GET",
    path: "/api/v1/repos/search",
    query: { sort: "updated", order: "desc", limit: 50 },
  })) as { ok: boolean; value?: { status: number; data?: unknown }; error?: string };
  if (!r.ok) return repoListCache?.repos ?? [];
  // gitea-api provider 把 {ok, data:[...]} 响应体整体作为 data 返回，剥一层
  const payload = r.value?.data as
    | { ok?: boolean; data?: { full_name?: string }[] }
    | { full_name?: string }[]
    | undefined;
  const items = Array.isArray(payload) ? payload : (payload?.data ?? []);
  const repos = items.map((x) => x.full_name ?? "").filter(Boolean);
  if (repos.length > 0) repoListCache = { repos, ts: Date.now() };
  return repos;
}

/** 展开单个池条目：org:X → 该组织全部可访问仓库；普通仓库原样。展开失败返回空数组（宁澄清不猜） */
export async function expandRepoEntry(ctx: SeamContext, entry: string): Promise<string[]> {
  if (!entry.startsWith("org:")) return [entry];
  const org = entry.slice(4).trim().toLowerCase();
  if (!org) return [];
  const repos = await listAccessibleRepos(ctx);
  return repos.filter((r) => (r.split("/")[0] ?? "").toLowerCase() === org);
}

/**
 * 群 → 已展开候选池（被动判定与主动指令反问共用同一真相）：
 * 已映射群 → 展开其池条目；未映射但存在映射表 → 所有已映射池的并集
 * （全员群/机器人群模式：LLM 在映射仓库池里选）；完全无映射 → fallback（repos）。
 */
export async function chatPoolFor(
  ctx: SeamContext,
  chatRepoMap: Record<string, string[]>,
  chatId: string,
  fallback: string[],
): Promise<string[]> {
  const mapped = chatRepoMap[chatId];
  if (mapped) {
    const pools = await Promise.all(mapped.map((e) => expandRepoEntry(ctx, e)));
    return [...new Set(pools.flat())];
  }
  if (Object.keys(chatRepoMap).length === 0) return [...fallback];
  const union = await Promise.all(
    Object.values(chatRepoMap)
      .flat()
      .map((e) => expandRepoEntry(ctx, e)),
  );
  return [...new Set(union.flat())];
}

/** env TASK_CHAT_REPO_MAP → 群→候选池（被动判定与主动指令共用同一配置真相） */
export function chatRepoMapFromEnv(): Record<string, string[]> {
  return parseChatRepoMap(process.env["TASK_CHAT_REPO_MAP"]);
}

/**
 * 严格版群池：仅当群已映射时返回展开池，未映射返回 undefined。
 * 主动指令路径用它维持"未映射群保持原反问行为"，不被并集池误伤。
 */
export async function mappedChatPool(
  ctx: SeamContext,
  chatRepoMap: Record<string, string[]>,
  chatId: string,
): Promise<string[] | undefined> {
  const mapped = chatRepoMap[chatId];
  if (!mapped) return undefined;
  const pools = await Promise.all(mapped.map((e) => expandRepoEntry(ctx, e)));
  return [...new Set(pools.flat())];
}

// ── 群内澄清队列（多候选池判不动 → 群里回复「任务归属 N @仓库」落单） ──

export interface PendingTaskCandidate {
  /** 全局自增编号（群内回复用它认领，跨群不歧义） */
  no: number;
  chatId: string;
  title: string;
  priority: CandidateTask["priority"];
  reason?: string;
  /** 候选依据的原始消息编号（建单正文回填话题上下文用） */
  sources?: number[];
  /** 识别时的原始消息文本（与判定输入 [1..n] 同序；澄清归属建单时引用） */
  texts?: string[];
  /** 识别时的候选仓库池（澄清消息展示） */
  pool: string[];
  collectedAt: string;
  /** 飞书先行模式：识别时已建的飞书任务 guid（归属确认后改写标题/挪分组，而非重建） */
  feishuTaskGuid?: string;
  /** 已确认的归属仓库（full_name；飞书先行模式下「任务归属」确认后回填） */
  assignedRepo?: string;
}

const pendingCandidates = new Map<number, PendingTaskCandidate>();
let nextPendingNo = 1;
const PENDING_LIMIT = 50;

/** 候选进澄清队列（超限淘汰最老项；编号全局递增） */
export function addPendingCandidate(
  chatId: string,
  c: {
    title: string;
    priority: CandidateTask["priority"];
    reason?: string;
    sources?: number[];
    /** 飞书先行模式：识别时已建的飞书任务 guid */
    feishuTaskGuid?: string;
  },
  pool: string[],
  texts?: string[],
): PendingTaskCandidate {
  while (pendingCandidates.size >= PENDING_LIMIT) {
    const oldest = pendingCandidates.keys().next().value;
    if (oldest === undefined) break;
    pendingCandidates.delete(oldest);
  }
  const item: PendingTaskCandidate = {
    no: nextPendingNo++,
    chatId,
    title: c.title,
    priority: c.priority,
    reason: c.reason,
    sources: c.sources,
    texts: texts ? [...texts] : undefined,
    pool: [...pool],
    collectedAt: new Date().toISOString(),
    feishuTaskGuid: c.feishuTaskGuid,
  };
  pendingCandidates.set(item.no, item);
  return item;
}

/** 只看不取（仓库解析失败时保留队列项，可重试） */
export function peekPendingCandidate(chatId: string, no: number): PendingTaskCandidate | undefined {
  const item = pendingCandidates.get(no);
  return item && item.chatId === chatId ? item : undefined;
}

/** 取出消费（chatId 不符返回 undefined——只能在识别它的群里认领，防跨群误领） */
export function takePendingCandidate(chatId: string, no: number): PendingTaskCandidate | undefined {
  const item = peekPendingCandidate(chatId, no);
  if (item) pendingCandidates.delete(no);
  return item;
}

export function dropPendingCandidate(chatId: string, no: number): boolean {
  return takePendingCandidate(chatId, no) !== undefined;
}

/**
 * 不限群按编号查候选（只看不取）：飞书先行模式下「安排执行者 N」可能发生在
 * 归属确认之前（此时编号=澄清队列编号），执行者安排需要按候选上的飞书任务
 * guid 定位任务；不校验 chatId（执行者安排可在群内任意成员发起）。
 */
export function findPendingCandidateByNo(no: number): PendingTaskCandidate | undefined {
  return pendingCandidates.get(no);
}

/** 飞书先行开关：env TASK_FEISHU_FIRST 显式为 0/false/off 时回到旧「汇总即建工单」链路；
 *  默认开启——汇总先建飞书任务入「P 计划中」，归属+执行者齐备后由 plan-gate 回填工单。 */
export function feishuFirstEnabled(): boolean {
  const v = (process.env["TASK_FEISHU_FIRST"] ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** 仅供测试：清空澄清队列与仓库列表缓存 */
export function clearPendingCandidates(): void {
  pendingCandidates.clear();
  repoListCache = null;
}

// ── Provider 实现 ────────────────────────────────────────────────

interface PipelineRuntime {
  timer: ReturnType<typeof setInterval> | null;
  seenPrs: Set<string>;
  started: boolean;
  lastRunTs: number;
}

const runtime: PipelineRuntime = {
  timer: null,
  seenPrs: new Set(),
  started: false,
  lastRunTs: 0,
};

/** 群播报函数（由装配层注入：ingress 返回的 send）。未注入则只建单不播报。 */
let notifySend: ((chatId: string, text: string) => Promise<void>) | undefined;

export function setNotifySend(fn: (chatId: string, text: string) => Promise<void>): void {
  notifySend = fn;
}

/** action 语义 → gitea-api 透传请求（Gitea v1 路径） */
function giteaRequest(req: Record<string, unknown>): Record<string, unknown> | null {
  const repo = String(req.repo ?? "");
  switch (req.action) {
    case "list_issues": {
      const q: Record<string, string | number> = {
        state: String(req.state ?? "open"),
        limit: Number(req.limit ?? 20),
        type: "issues",
      };
      if (req.labels) q.labels = String(req.labels);
      return { method: "GET", path: `/api/v1/repos/${repo}/issues`, query: q };
    }
    case "create_issue":
      return {
        method: "POST",
        path: `/api/v1/repos/${repo}/issues`,
        body: { title: req.title, body: req.body ?? "", ...(req.labels ? { labels: req.labels } : {}) },
      };
    case "list_prs":
      return {
        method: "GET",
        path: `/api/v1/repos/${repo}/pulls`,
        query: { state: String(req.state ?? "open"), limit: Number(req.limit ?? 20) },
      };
    default:
      return null;
  }
}

async function callGitea(
  ctx: SeamContext,
  req: Record<string, unknown>,
): Promise<{ status: number; data: unknown } | null> {
  const passthrough = giteaRequest(req);
  if (!passthrough) {
    console.error(`[task-pipeline] 不支持的 gitea action: ${String(req.action)}`);
    return null;
  }
  const r = (await ctx.call(giteaApiRef, passthrough)) as {
    ok: boolean;
    value?: { status: number; data: unknown };
    error?: string;
  };
  if (!r.ok) {
    console.error(`[task-pipeline] gitea call failed: ${r.error}`);
    return null;
  }
  return r.value ?? null;
}

async function notify(ctx: SeamContext, chatId: string | undefined, send: ((chatId: string, text: string) => Promise<void>) | undefined, text: string): Promise<void> {
  if (!chatId || !send) return;
  try {
    await send(chatId, text);
  } catch (e) {
    console.error(`[task-pipeline] notify failed: ${String(e)}`);
  }
}

export const taskPipelineProvider: Provider<TaskPipelineRequest, TaskPipelineResponse> = {
    service: taskPipelineService,
    name: "orchestration-task-pipeline",
    state: PluginState.Active,

    async execute(
      request: TaskPipelineRequest,
      ctx: SeamContext,
    ): Promise<Result<TaskPipelineResponse>> {
      const intervalMs = request.intervalMs ?? 600_000;
      const quietMs = request.quietMs ?? defaultQuietMs();
      const maxBatch = request.maxBatch ?? 40;
      const bufferLimit = request.bufferLimit ?? 200;
      const repos = request.repos;
      const chatRepoMap = request.chatRepoMap ?? {};
      const threshold = request.dedupThreshold ?? 0.5;
      const model = request.model ?? process.env.TASK_PIPELINE_MODEL ?? "qwen-turbo";

      if (runtime.timer) clearInterval(runtime.timer);

      const tick = async (): Promise<void> => {
        runtime.lastRunTs = Date.now();
        try {
          // ── 1. 汇总判定（按来源群分桶：群 = 归属参考，跨群绝不混判） ──
          if (buffer.length > 0) {
            const batch = buffer.splice(0, maxBatch);
            interface Judged {
              chatId: string;
              pool: string[];
              candidates: CandidateTask[];
              /** 与 candidates 编号对应的原始消息文本（[1..n] 同序），供建单正文回填话题上下文 */
              texts: string[];
            }
            const judged: Judged[] = [];
            const requeue: CollectedMessage[] = [];
            for (const [chatId, msgs] of groupByChat(batch)) {
              const pool = await chatPoolFor(ctx, chatRepoMap, chatId, repos);
              const texts = msgs.map(
                (m) => `${new Date(m.ts).toISOString().slice(11, 16)} ${m.text}`,
              );
              const llm = (await ctx.call(llmInferenceRef, {
                model,
                messages: buildJudgeMessages(texts, pool.length > 0 ? pool : repos),
                temperature: 0.2,
                max_tokens: 2000,
              })) as { ok: boolean; value?: { text?: string }; error?: string };
              if (!llm.ok || !llm.value?.text) {
                // LLM 不可用：该群消息放回缓冲头部，等下个 tick 重试
                requeue.push(...msgs);
                console.error(`[task-pipeline] LLM 不可用，群 ${chatId} 的 ${msgs.length} 条消息保留缓冲: ${llm.error ?? "空响应"}`);
                continue;
              }
              // 代码闸门：LLM 标 confident=false（拿不准/报告类误判兜底）的候选直接丢弃
              judged.push({
                chatId,
                pool,
                candidates: parseCandidateTasks(llm.value.text).filter((c) => c.confident !== false),
                texts,
              });
            }
            if (requeue.length > 0) {
              buffer.unshift(...requeue);
              if (buffer.length > bufferLimit) buffer.length = bufferLimit;
            }

            if (judged.some((j) => j.candidates.length > 0)) {
              // ── 2. 查重：Gitea open 工单（覆盖本批涉及的全部仓库）+ 飞书任务 ──
              const existingTitles: string[] = [];
              for (const repo of [...new Set([...repos, ...judged.flatMap((j) => j.pool)])]) {
                const r = await callGitea(ctx, { action: "list_issues", repo, state: "open", limit: 50 });
                if (r && Array.isArray(r.data)) {
                  for (const it of r.data as Array<{ title?: string }>) {
                    if (it.title) existingTitles.push(it.title);
                  }
                }
              }
              const fr = (await ctx.call(feishuApiRef, {
                method: "GET",
                path: "/open-apis/task/v2/tasks",
                query: { page_size: 50, user_id_type: "open_id" },
                identity: "user",
              })) as { ok: boolean; value?: { data?: { items?: Array<{ summary?: string; status?: string }> } } };
              if (fr.ok) {
                for (const t of fr.value?.data?.items ?? []) {
                  if (t.status !== "done" && t.summary) existingTitles.push(t.summary);
                }
              }

              // ── 3. 归属分派 + 落库：飞书先行模式（默认）先建飞书任务挂 org 清单
              //      「P 计划中」，归属+执行者齐备后由 plan-gate 回填建工单；
              //      TASK_FEISHU_FIRST=0 回到旧「汇总即建工单」链路（保留兼容）──
              const feishuFirst = feishuFirstEnabled();
              const scoped = judged.flatMap((j) =>
                j.candidates.map((c) => ({ c, chatId: j.chatId, pool: j.pool, texts: j.texts })),
              );
              const kept = new Set(filterDuplicates(scoped.map((s) => s.c), existingTitles, threshold));
              const created: Array<{ chatId: string; line: string }> = [];
              const clarify: Array<{ chatId: string; item: PendingTaskCandidate }> = [];
              let dupCount = 0;
              for (const { c, chatId, pool, texts } of scoped) {
                if (!kept.has(c)) {
                  dupCount++;
                  continue;
                }
                const repo = assignRepoForPool(c, pool);
                if (feishuFirst) {
                  // 飞书先行：先建飞书任务（不带 [repo#N] 前缀），挂 org 清单 P 分组。
                  // 单仓池命中 → 该仓库 org；判不动 → 池首/兜底 repos[0] 的 org，
                  // 同时进澄清队列携带任务 guid（归属确认后改写标题而非重建）。
                  const orgRepo = repo ?? pool[0] ?? repos[0];
                  let taskGuid: string | undefined;
                  try {
                    const sr = (await ctx.call(taskIssueSyncRef, {
                      mode: "create-planned",
                      repo: orgRepo,
                      title: c.title,
                      priority: c.priority,
                      sourceChatId: chatId === "*" ? undefined : chatId,
                    })) as { ok?: boolean; value?: { response?: string; taskGuid?: string }; error?: string };
                    taskGuid = sr.ok ? sr.value?.taskGuid : undefined;
                    console.log(
                      `[task-pipeline] 飞书先行建任务 [${c.priority}] ${c.title}: ${
                        sr.ok ? (sr.value?.response ?? "ok") : (sr.error ?? "failed")
                      }`,
                    );
                  } catch (e) {
                    console.error(`[task-pipeline] 飞书先行建任务异常(不阻断): ${String((e as Error)?.message ?? e)}`);
                  }
                  if (repo) {
                    created.push({ chatId, line: `${orgRepo} 清单 [${c.priority}] ${c.title}` });
                  } else {
                    clarify.push({
                      chatId,
                      item: addPendingCandidate(chatId, { ...c, feishuTaskGuid: taskGuid }, pool, texts),
                    });
                  }
                  continue;
                }
                if (!repo) {
                  clarify.push({ chatId, item: addPendingCandidate(chatId, c, pool, texts) });
                  continue;
                }
                const r = await callGitea(ctx, {
                  action: "create_issue",
                  repo,
                  title: `[${c.priority}] ${c.title}`,
                  body: buildIssueBody(c.reason, texts, c.sources, chatId),
                });
                if (r && typeof r.data === "object" && r.data !== null) {
                  const issue = r.data as { number?: number; html_url?: string };
                  created.push({ chatId, line: `${repo}#${issue.number ?? "?"} [${c.priority}] ${c.title}` });
                  // ── C 方案双建：自动建单 → 同步飞书任务挂 org 清单 ──
                  // 单一真相：复用 @orchestration/task-issue-sync 的 sync-issue 原语；
                  // 同步失败只记日志不阻断流水线（工单已建，真人可见）
                  try {
                    const sr = (await ctx.call(taskIssueSyncRef, {
                      mode: "sync-issue",
                      repo,
                      issue,
                      sourceChatId: chatId === "*" ? undefined : chatId,
                    })) as { ok?: boolean; value?: { response?: string }; error?: string };
                    console.log(
                      `[task-pipeline] 飞书同步 ${repo}#${issue.number}: ${
                        sr.ok ? (sr.value?.response ?? "ok") : (sr.error ?? "failed")
                      }`,
                    );
                  } catch (e) {
                    console.error(`[task-pipeline] 飞书同步异常(不阻断): ${String((e as Error)?.message ?? e)}`);
                  }
                }
              }

              // ── 4. 群播报：哪里聊的就在哪里通告/澄清（归属+执行者确认是 P→D 前置） ──
              const createdLines = new Map<string, string[]>();
              for (const { chatId, line } of created) {
                const list = createdLines.get(chatId) ?? [];
                list.push(line);
                createdLines.set(chatId, list);
              }
              for (const [chatId, lines] of createdLines) {
                const summaryMsg = feishuFirst
                  ? `🆕 群聊汇总：从本群近期的讨论里整理出 ${lines.length} 条任务，已建飞书任务并归入对应清单「P 计划中」：\n` +
                    lines.map((s) => `• ${s}`).join("\n") +
                    `\n\n请回复「任务归属 编号 @仓库」确认归属、「安排执行者 编号 @姓名」确认执行者；两者齐备后自动创建 Gitea 工单。`
                  : `🆕 群聊汇总：从本群近期的讨论里整理出 ${lines.length} 条任务，已建工单：\n` +
                    lines.map((s) => `• ${s}`).join("\n") +
                    `\n\n请回复「安排执行者 #工单号 @姓名」指定执行者；安排好执行者的任务才会进入执行队列。`;
                // 播报目标：配置了 notifyChatId（如「机器人群」）则所有播报只发该群，
                // 不再回源群（静默收集的结论统一在一个群里呈现）；未配置保持旧行为
                const target = request.notifyChatId || (chatId === "*" ? undefined : chatId);
                if (target) await notify(ctx, target, notifySend, summaryMsg);
              }
              const clarifyByChat = new Map<string, Array<{ chatId: string; item: PendingTaskCandidate }>>();
              for (const x of clarify) {
                const list = clarifyByChat.get(x.chatId) ?? [];
                list.push(x);
                clarifyByChat.set(x.chatId, list);
              }
              for (const [chatId, items] of clarifyByChat) {
                const poolNames = [...new Set(items.flatMap((x) => x.item.pool))].join(" / ");
                const msg = feishuFirst
                  ? `❓ 群聊汇总识别到 ${items.length} 条疑似任务，归属仓库拿不准（候选：${poolNames}），已先归入「P 计划中」：\n` +
                    items.map((x) => `${x.item.no}. [${x.item.priority}] ${x.item.title}`).join("\n") +
                    `\n\n回复「任务归属 编号 @仓库」确认归属、「安排执行者 编号 @姓名」确认执行者；两者齐备后自动创建 Gitea 工单。回复「跳过任务 编号」丢弃。`
                  : `❓ 群聊汇总识别到 ${items.length} 条疑似任务，但归属仓库拿不准（候选：${poolNames}）：\n` +
                    items.map((x) => `${x.item.no}. [${x.item.priority}] ${x.item.title}`).join("\n") +
                    `\n\n回复「任务归属 编号 @仓库名」创建工单，回复「跳过任务 编号」丢弃。`;
                const target = request.notifyChatId || (chatId === "*" ? undefined : chatId);
                if (target) await notify(ctx, target, notifySend, msg);
              }
              if (feishuFirst) {
                if (created.length > 0 || clarify.length > 0) {
                  console.log(`[task-pipeline] 飞书先行：新建计划任务 ${created.length + clarify.length} 条（其中待澄清归属 ${clarify.length} 条），重复跳过 ${dupCount} 条`);
                } else {
                  console.log(`[task-pipeline] 判定 ${scoped.length} 条候选，全部与现有任务/工单重复`);
                }
              } else if (created.length > 0 || clarify.length > 0) {
                console.log(`[task-pipeline] 新建工单 ${created.length} 条，进澄清 ${clarify.length} 条，重复跳过 ${dupCount} 条`);
              } else {
                console.log(`[task-pipeline] 判定 ${scoped.length} 条候选，全部与现有任务/工单重复`);
              }
            }
          } else if (buffer.length > bufferLimit) {
            buffer.length = bufferLimit;
          }

          // ── 4. PR 轮询提醒 ──
          if (request.notifyChatId) {
            const newPrs: string[] = [];
            for (const repo of repos) {
              const r = await callGitea(ctx, { action: "list_prs", repo, state: "open", limit: 30 });
              if (r && Array.isArray(r.data)) {
                for (const pr of r.data as Array<{ number?: number; title?: string; html_url?: string }>) {
                  const key = `${repo}#${pr.number}`;
                  if (!runtime.seenPrs.has(key)) {
                    runtime.seenPrs.add(key);
                    // 首个 tick 只记录基线不提醒，避免每次重启轰炸
                    if (runtime.started) {
                      newPrs.push(`${repo}!${pr.number} ${pr.title ?? ""}`);
                    }
                  }
                }
              }
            }
            if (newPrs.length > 0) {
              await notify(ctx, request.notifyChatId, notifySend, `🔀 检测到 ${newPrs.length} 个待合并 PR：\n${newPrs.map((s) => `• ${s}`).join("\n")}`);
            }
          }
        } catch (e) {
          console.error(`[task-pipeline] tick error: ${String(e)}`);
        }
      };

      if (request.runOnStart !== false) {
        runtime.started = false;
        void tick().then(() => {
          runtime.started = true;
        });
      } else {
        runtime.started = true;
      }
      // 静默窗口调度：短间隔轮询判定，静默满 quietMs 即汇总（防抖），
      // 兜底每 intervalMs 必跑一次（保 PR 轮询等周期性职责）
      const pollMs = Math.max(5_000, Math.min(30_000, Math.floor(quietMs / 4)));
      runtime.timer = setInterval(() => {
        if (
          shouldFireTick({
            bufferLen: buffer.length,
            now: Date.now(),
            lastCollectTs,
            lastRunTs: runtime.lastRunTs,
            quietMs,
            intervalMs,
          })
        ) {
          void tick();
        }
      }, pollMs);

      return ok({
        ok: true,
        intervalMs,
        quietMs,
        stop: () => {
          if (runtime.timer) clearInterval(runtime.timer);
          runtime.timer = null;
        },
      });
    },

    async health(): Promise<HealthStatus> {
      return {
        healthy: runtime.timer !== null,
        detail: runtime.timer ? "running" : "not started",
        checkedAt: new Date().toISOString(),
      };
    },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@orchestration/task-pipeline",
  layer: LayerId.Orchestration,
  description: "编排规划层：群聊→任务→工单→PR提醒 流水线（只管理不执行）",
  version: "1.0.0",
  provides: [taskPipelineService],
  consumes: [llmInferenceRef, feishuApiRef, giteaApiRef],
  preferredCarrier: CarrierKind.Thread,
};
