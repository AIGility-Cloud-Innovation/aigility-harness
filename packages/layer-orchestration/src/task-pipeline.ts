/**
 * L4 编排规划层: task-pipeline — 群聊 → 整理 → 播报/建单 流水线（工作流化）
 *
 * 架构（对齐 workflow-driver 的数据面/执行面分界）：
 *   - 执行面（代码，本文件的 Provider）：监听缓冲 + 静默窗口/兜底定时触发 +
 *     PR 轮询提醒——过程驱动的触发器逻辑不进 YAML；
 *   - 数据面（YAML 工作流）：一批群消息的处理过程 = collect → summarize →
 *     dedupe → create_task → create_issue → digest → notify 线性链，
 *     每个节点 enabled 开关可直接在 YAML 里控制功能——
 *     create_task / create_issue 设 enabled: false 即「只整理发摘要、不建单」。
 *
 * YAML 来源：request.workflowFile 每次触发前重新读取（改文件即生效，无需
 * 重启）；未提供时用内置默认（使能态尊重 TASK_FEISHU_FIRST 旧开关）。
 *
 * 节点语义：
 *   1. collect   取缓冲一批（maxBatch 截断）
 *   2. summarize 按来源群分桶调 LLM 判定疑似任务（LLM 不可用 → 消息回缓冲重试）
 *   3. dedupe    与 Gitea open 工单 + 飞书任务查重（bigram Jaccard）
 *   4. create_task    飞书先行：建「P 计划中」任务，归属拿不准进澄清队列
 *   5. create_issue   旧链路：直接建 Gitea 工单（未处理候选才轮得到它）
 *   6. digest    组装播报：有建单结果按建单措辞；建单节点全禁用时纯摘要
 *   7. notify    播报到 notifyChatId（如「机器人群」），未配置则回来源群
 *
 * 只管理，不执行：本服务不写代码，执行由 codex 系工人/真人完成。
 *
 * LLM 判定容错：LLM 不可用时消息保留在缓冲（有上限），下个 tick 重试。
 * 状态（已见 PR、缓冲）存内存，重启后 PR 会重新提醒一次，可接受。
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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { YamlWorkflow, parseWorkflowYaml, loadWorkflowFile } from "./workflow-driver.js";
import type { TaskRegistry } from "./task-registry.js";
import type { WorkflowDoc } from "./workflow-driver.js";
import { resolveChatName } from "./task-issue-sync.js";
import { nodeRequest, withNodeDefaults } from "./llm-node-port.js";
import { getIdentityRegistry, findMemberByFeishuOpenId, identityMembers } from "./identity-registry.js";

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

/** 群聊动态沉淀：按发言人写回各自太忆空间（@action/timem-memory-write） */
export const timemMemoryWriteRef: CapabilityRef = {
  id: "@action/timem-memory-write",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface TaskPipelineRequest {
  /**
   * 任务台账（2026-10-05）：digest-only 候选入台账获得 R 短码，播报/回复
   * 统一用 R 码。由装配层传入共享实例（与复核人格/对齐器同进程单例）。
   */
  registry?: TaskRegistry;
  /** 复核短码会话文件路径（R 码分配持久化）；缺省不分配短码 */
  reviewCodeFile?: string;
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
  /**
   * 数据面工作流 YAML 文件路径（节点 + 边 + enabled 开关）。每次触发前重新
   * 读取——改文件即生效，无需重启。未提供时用内置默认（create_task 使能态
   * 尊重 TASK_FEISHU_FIRST，create_issue 取反）。
   */
  workflowFile?: string;
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
    "群聊监听（执行面触发）→ YAML 工作流：分群判定→查重→建单(enabled 可关)→摘要播报；PR 轮询提醒（只管理不执行）",
};

// ── 监听缓冲（装配层喂入） ────────────────────────────────────────

export interface CollectedMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  ts: number;
  /** 来源类型（group/p2p）；p2p = 私聊汇报（播报措辞区分用） */
  chatType?: string;
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
  /** 上下文明确指向的执行人/负责人姓名或昵称（如「hongbin 的修改」→ hongbin）；无指向留空 */
  executor?: string;
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
        executor:
          typeof o.executor === "string" && o.executor.trim()
            ? o.executor.trim().slice(0, 32)
            : undefined,
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
  chatName?: string,
): string {
  const discussion = quoteDiscussion(texts, sources);
  const chatDisplay = chatName ?? (chatId === "*" ? "未知" : chatId);
  return (
    `> 来源：飞书群聊自动汇总（${new Date().toISOString()}）\n` +
    `>\n` +
    `> 判定依据：${reason ?? "LLM 判定为待执行任务"}\n` +
    `> 来源群：${chatDisplay}\n` +
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
        `数组每项格式：{"title":"任务标题(简洁动宾短语)","priority":"P0|P1|P2|P3","repo":"归属仓库","executor":"执行人","confident":true,"reason":"一句话依据","sources":[1,3]}\n` +
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
        `- executor：消息里明确指向的执行人/负责人（如「hongbin 的修改还没合并」→ hongbin、「让张三修」→ 张三）；没有明确指向就填空字符串，禁止猜测\n` +
        `- 输出示例：[{"title":"修复登录页白屏","priority":"P1","repo":"${repos[0] ?? "TiMEM-AI/TiMEM-Space"}","executor":"","confident":true,"reason":"明确报告了线上bug","sources":[1]}]\n` +
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
  /** 已确认的执行人（「安排执行者 编号 姓名」记录） */
  executor?: string;
  /** 摘要条目（digest-only）：随摘要展示给人工核验的 LLM 判断 */
  fromDigest?: boolean;
  suggestedRepo?: string;
  suggestedExecutor?: string;
  /** 归属是低置信猜测（私聊/并集池）：「确认」时不作为已定项目，需人工明确 */
  repoUncertain?: boolean;
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
    /** 摘要条目：随摘要展示的 LLM 判断（digest-only 记录模式用） */
    fromDigest?: boolean;
    suggestedRepo?: string;
    suggestedExecutor?: string;
    repoUncertain?: boolean;
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
    fromDigest: c.fromDigest,
    suggestedRepo: c.suggestedRepo,
    suggestedExecutor: c.suggestedExecutor,
    repoUncertain: c.repoUncertain,
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
  digestItemsByMessage.clear();
  recentDigestTitles.length = 0;
}

// ── 摘要核验的引用定位与播报记账 ─────────────────────────────────

/**
 * 摘要消息 id → 条目编号（人工核验用）：用户在飞书里「引用回复」摘要时可以
 * 省略编号——root_id 即摘要消息 id，从这里反查条目。FIFO 上限防膨胀。
 */
const digestItemsByMessage = new Map<string, number[]>();
const DIGEST_MAP_LIMIT = 200;

export function recordDigestMessage(messageId: string, nos: number[]): void {
  if (!messageId || nos.length === 0) return;
  while (digestItemsByMessage.size >= DIGEST_MAP_LIMIT) {
    const oldest = digestItemsByMessage.keys().next().value;
    if (oldest === undefined) break;
    digestItemsByMessage.delete(oldest);
  }
  digestItemsByMessage.set(messageId, nos);
}

/** 引用回复的摘要消息 id → 其中仍在队列里的条目（用于省略编号的核验指令） */
export function pendingNosForRootMessage(rootId?: string): number[] {
  if (!rootId) return [];
  return [...(digestItemsByMessage.get(rootId) ?? [])];
}

/**
 * 已播报条目标题滚动窗口（digest-only 模式的查重记账）：不建单时播过的条目
 * 在工单/任务里查不到，没有这个窗口同一件事会被每批重复播报。24h 过期。
 */
const recentDigestTitles: Array<{ title: string; ts: number }> = [];
const DIGEST_TITLE_TTL_MS = 24 * 60 * 60 * 1000;

export function recordDigestTitles(titles: string[]): void {
  const now = Date.now();
  for (const t of titles) {
    if (t) recentDigestTitles.push({ title: t, ts: now });
  }
  while (recentDigestTitles.length > 0 && now - recentDigestTitles[0].ts > DIGEST_TITLE_TTL_MS) {
    recentDigestTitles.shift();
  }
}

/** 窗口内标题（查重用，过期条目顺手清理） */
function recentTitlesForDedupe(): string[] {
  const now = Date.now();
  while (recentDigestTitles.length > 0 && now - recentDigestTitles[0].ts > DIGEST_TITLE_TTL_MS) {
    recentDigestTitles.shift();
  }
  return recentDigestTitles.map((x) => x.title);
}


// ── R 短码会话读写（与复核人格共用同一会话文件） ──────────────────

function loadReviewCodes(file: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveReviewCodes(file: string, codes: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(codes, null, 2));
}

function nextReviewCode(codes: Record<string, string>): string {
  const max = Object.keys(codes).reduce((m, k) => Math.max(m, Number(k.replace(/^R/, "")) || 0), 0);
  return `R${String(max + 1).padStart(2, "0")}`;
}

// ── 数据面工作流：state 类型 + 内置默认 + 加载 ───────────────────

/** summarize 节点产出：按来源群的判定结果 */
export interface JudgedChat {
  chatId: string;
  pool: string[];
  candidates: CandidateTask[];
  /** 判定输入的原始消息文本（[1..n] 同序），建单正文/摘要回填用 */
  texts: string[];
  /** 来源类型（group/p2p），播报措辞区分用 */
  chatType?: string;
  /** 候选池是否确定（群有映射）；私聊/并集池 = false，归属展示按低置信处理 */
  poolDefinite?: boolean;
}

/** 跨群拉平后的待处理候选（dedupe 打重复标记，建单节点打已处理标记） */
export interface ScopedCandidate {
  chatId: string;
  pool: string[];
  texts: string[];
  candidate: CandidateTask;
  /** 候选池是否确定（群有映射）；私聊/并集池 = false */
  poolDefinite?: boolean;
  /** 与现有工单/任务重复（阈值以上），建单节点跳过 */
  dup?: boolean;
  /** 已被建单节点处理（建任务/建工单/进澄清） */
  done?: boolean;
}

export interface CreatedLine {
  chatId: string;
  line: string;
}

export interface ClarifyEntry {
  chatId: string;
  item: PendingTaskCandidate;
}

export interface OutboundMessage {
  /** 播报目标群；undefined = 无目标不发送（未配 notifyChatId 且来源群为 *） */
  target?: string;
  text: string;
  /** 摘要条目（编号 → 消息 id 映射，引用回复省略编号时定位用） */
  items?: Array<{ no?: number }>;
  /** 本条摘要承载的候选标题（播报成功后进查重记账窗口） */
  titles?: string[];
}

/** 工作流 state（节点间流动；节点返回增量合并回此对象） */
export interface PipelineState {
  batch: CollectedMessage[];
  /** LLM 不可用的消息，运行后由 Provider 放回缓冲头部重试 */
  requeue: CollectedMessage[];
  judged: JudgedChat[];
  scoped: ScopedCandidate[];
  created: CreatedLine[];
  clarify: ClarifyEntry[];
  /** 实际执行的建单节点写入：feishu-first | legacy；未建单 = digest-only */
  creationMode?: "feishu-first" | "legacy";
  messages: OutboundMessage[];
}

/**
 * 内置默认工作流（request.workflowFile 未提供时的兜底）。
 * create_task / create_issue 的使能态由 loadPipelineDoc 按 TASK_FEISHU_FIRST
 * 映射（保持旧开关语义）；正式部署请提供 YAML 文件，以文件里的 enabled 为准。
 */
export const BUILTIN_PIPELINE_YAML = `
workflow:
  name: chat-briefing
  description: 群聊消息批处理 — 分群判定 → 查重 → (可选建单) → 摘要播报
  entry_point: collect
  nodes:
    collect:
      type: function_node
      function_ref: collect_batch
      description: 取监听缓冲一批消息（触发由执行面静默窗口/定时负责）
    summarize:
      type: function_node
      function_ref: summarize_per_chat
      description: 按来源群分桶调 LLM 判定疑似任务
    memory_precipitate:
      type: function_node
      function_ref: memory_precipitate
      description: "群聊动态按发言人蒸馏写入各自太忆空间（TASK_CHAT_MEMORY=0 关）"
    dedupe:
      type: function_node
      function_ref: dedupe_candidates
      description: 与 Gitea open 工单/飞书任务查重（bigram Jaccard）
    create_task:
      type: function_node
      function_ref: create_planned_tasks
      description: "飞书先行：建「P 计划中」任务（enabled 开关）"
    create_issue:
      type: function_node
      function_ref: create_gitea_issues
      description: "旧链路：直接建 Gitea 工单（enabled 开关）"
    digest:
      type: function_node
      function_ref: build_digest
      description: 组装播报文案（建单结果或纯摘要）
    notify:
      type: function_node
      function_ref: broadcast_digest
      description: 播报到 notifyChatId（机器人群）或来源群
  flow:
    edges:
      - { from: collect, to: summarize }
      - { from: summarize, to: memory_precipitate }
      - { from: memory_precipitate, to: dedupe }
      - { from: dedupe, to: create_task }
      - { from: create_task, to: create_issue }
      - { from: create_issue, to: digest }
      - { from: digest, to: notify }
      - { from: notify, to: __end__ }
`;

/**
 * 加载本轮生效的工作流文档：workflowFile 每次触发重新读取（改文件即生效），
 * 加载失败回退内置默认；内置默认按 TASK_FEISHU_FIRST 映射建单节点使能态
 * （旧开关语义，仅兜底路径生效——文件版以 YAML 内 enabled 为唯一真相）。
 */
export function loadPipelineDoc(workflowFile?: string): { doc: WorkflowDoc; source: string } {
  if (workflowFile) {
    try {
      return { doc: loadWorkflowFile(workflowFile), source: workflowFile };
    } catch (e) {
      console.error(`[task-pipeline] 工作流文件加载失败, 回退内置默认: ${String((e as Error)?.message ?? e)}`);
    }
  }
  const doc = parseWorkflowYaml(BUILTIN_PIPELINE_YAML);
  const feishuFirst = feishuFirstEnabled();
  doc.nodes["create_task"].enabled = feishuFirst;
  doc.nodes["create_issue"].enabled = !feishuFirst;
  return { doc, source: "builtin" };
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

/** 群播报函数（由装配层注入：ingress 返回的 send，返回消息 id 供引用定位）。未注入则只建单不播报。 */
let notifySend: ((chatId: string, text: string) => Promise<string | void>) | undefined;

export function setNotifySend(fn: (chatId: string, text: string) => Promise<string | void>): void {
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

async function notify(ctx: SeamContext, chatId: string | undefined, send: ((chatId: string, text: string) => Promise<string | void>) | undefined, text: string): Promise<void> {
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
      // 判定模型优先级：请求显式 model > 节点 task-judge > env TASK_PIPELINE_MODEL > 内置默认。
      // 首次对拍建议节点与 env 配成同款模型，确认「走节点」与「走 env」行为一致后再于页面切模型。
      const judgeParts = await nodeRequest("task-judge");
      const model = request.model ?? judgeParts?.model ?? process.env.TASK_PIPELINE_MODEL ?? "qwen-turbo";
      if (judgeParts) {
        console.log(`[task-pipeline] 判定模型来源节点 task-judge: model=${judgeParts.model}${request.model ? "（被请求显式 model 覆盖）" : ""}`);
      }
      const workflowFile = request.workflowFile;

      if (runtime.timer) clearInterval(runtime.timer);

      // 启动即校验生效工作流并打印节点使能态（之后每轮触发前重读文件，改 YAML 即生效）
      {
        const { doc, source } = loadPipelineDoc(workflowFile);
        const ids = Object.keys(doc.nodes);
        const off = ids.filter((id) => doc.nodes[id]?.enabled === false);
        console.log(
          `[task-pipeline] 数据面工作流「${doc.name}」(${source === "builtin" ? "内置默认" : source}): ${ids.join("→")}` +
            (off.length > 0 ? ` (禁用: ${off.join(",")})` : ""),
        );
      }

      // ── 数据面节点实现（闭包绑定请求参数，复用上方纯函数与 Seam 调用） ──
      const nodeFns = {
        collect_batch: (s: PipelineState): Partial<PipelineState> => {
          const batch = buffer.splice(0, maxBatch);
          if (buffer.length > bufferLimit) buffer.length = bufferLimit;
          return { batch };
        },

        summarize_per_chat: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const judged: JudgedChat[] = [];
          const requeue: CollectedMessage[] = [];
          for (const [chatId, msgs] of groupByChat(s.batch)) {
            const pool = await chatPoolFor(ctx, chatRepoMap, chatId, repos);
            const texts = msgs.map(
              (m) => `${new Date(m.ts).toISOString().slice(11, 16)} ${m.text}`,
            );
            const llm = (await ctx.call(llmInferenceRef, withNodeDefaults(judgeParts, {
              model,
              messages: buildJudgeMessages(texts, pool.length > 0 ? pool : repos),
              temperature: 0.2,
              max_tokens: 2000,
            }))) as { ok: boolean; value?: { text?: string }; error?: string };
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
              chatType: msgs[0]?.chatType,
              poolDefinite: Boolean(chatRepoMap[chatId]),
            });
          }
          return { judged, requeue };
        },

        // 群聊动态 → 太忆空间（2026-10-09）：任务判定之外，把每个发言人
        // 本窗口的发言蒸馏成一条记忆写回其太忆空间（timem_user_ids[0]）。
        // 未登记飞书 open_id 的发言人跳过（写入无名空间无法归属，只会污染检索）。
        // TASK_CHAT_MEMORY=0 可关；失败只记日志不阻断流水线。
        memory_precipitate: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const flag = (process.env["TASK_CHAT_MEMORY"] ?? "1").toLowerCase();
          if (["0", "false", "off"].includes(flag)) return {};
          const registryFile = getIdentityRegistry();
          let written = 0;
          let skippedUnknown = 0;
          for (const msgs of groupByChat(s.batch).values()) {
            // 同一发言人一个窗口一条：去重后按时间拼，限长防刷记忆
            const bySender = new Map<string, string[]>();
            for (const m of msgs) {
              const t = (m.text ?? "").trim();
              if (!t) continue;
              const list = bySender.get(m.senderId) ?? [];
              if (!list.includes(t)) list.push(t);
              bySender.set(m.senderId, list);
            }
            const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
            for (const [senderId, texts] of bySender) {
              if (written >= 8) break; // 单窗口每人一条还不够就砍，防异常刷屏
              const member = findMemberByFeishuOpenId(registryFile, senderId);
              const space = member?.timem_user_ids?.[0];
              if (!space) {
                skippedUnknown++;
                continue;
              }
              const body = texts.join("；").slice(0, 600);
              try {
                const r = (await ctx.call(timemMemoryWriteRef, {
                  content: `【群聊动态·${stamp}】${member!.name} 在飞书群聊中提到：${body}`,
                  user_id: space,
                  agent_id: "task-pipeline",
                })) as { ok?: boolean; value?: { ok?: boolean; error?: string }; error?: string };
                if (r?.ok && r.value?.ok !== false) written++;
                else console.error(`[task-pipeline] 群聊记忆写入失败 ${member!.name}: ${r?.value?.error ?? r?.error ?? "unknown"}`);
              } catch (e) {
                console.error(`[task-pipeline] 群聊记忆写入异常 ${member!.name}: ${String((e as Error)?.message ?? e)}`);
              }
            }
          }
          if (written || skippedUnknown) {
            console.log(`[task-pipeline] 群聊记忆沉淀: 写入 ${written} 条${skippedUnknown ? `（跳过未登记发言人 ${skippedUnknown} 人次）` : ""}`);
          }
          return {};
        },

        dedupe_candidates: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const scoped: ScopedCandidate[] = (s.judged ?? []).flatMap((j) =>
            j.candidates.map((c) => ({ chatId: j.chatId, pool: j.pool, texts: j.texts, candidate: c, poolDefinite: j.poolDefinite })),
          );
          if (scoped.length === 0) return { scoped };
          // 查重基准：台账活跃条目（永久落盘，重启免疫——修复内存 24h 窗口跨重启重复入库）
          // + Gitea open 工单（覆盖本批涉及的全部仓库）+ 飞书未完成任务
          const existingTitles: string[] = request.registry
            ? request.registry
                .list({ status: ["planned", "ready", "dispatched", "running", "review", "blocked", "failed"] })
                .map((r) => r.title)
            : [];
          existingTitles.push(...recentTitlesForDedupe());
          for (const repo of [...new Set([...repos, ...scoped.flatMap((x) => x.pool)])]) {
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
          const kept = new Set(filterDuplicates(scoped.map((x) => x.candidate), existingTitles, threshold));
          for (const x of scoped) x.dup = !kept.has(x.candidate);
          return { scoped };
        },

        create_planned_tasks: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const created = [...(s.created ?? [])];
          const clarify = [...(s.clarify ?? [])];
          let processed = 0;
          for (const x of s.scoped ?? []) {
            if (x.dup || x.done) continue;
            const c = x.candidate;
            // 飞书先行：先建飞书任务（不带 [repo#N] 前缀），挂 org 清单 P 分组。
            // 单仓池命中 → 该仓库 org；判不动 → 池首/兜底 repos[0] 的 org，
            // 同时进澄清队列携带任务 guid（归属确认后改写标题而非重建）。
            const repo = assignRepoForPool(c, x.pool);
            const orgRepo = repo ?? x.pool[0] ?? repos[0];
            let taskGuid: string | undefined;
            try {
              const sr = (await ctx.call(taskIssueSyncRef, {
                mode: "create-planned",
                repo: orgRepo,
                title: c.title,
                priority: c.priority,
                sourceChatId: x.chatId === "*" ? undefined : x.chatId,
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
              created.push({ chatId: x.chatId, line: `${orgRepo} 清单 [${c.priority}] ${c.title}` });
            } else {
              clarify.push({
                chatId: x.chatId,
                item: addPendingCandidate(x.chatId, { ...c, feishuTaskGuid: taskGuid }, x.pool, x.texts),
              });
            }
            x.done = true;
            processed++;
          }
          const patch: Partial<PipelineState> = { created, clarify };
          if (processed > 0 && !s.creationMode) patch.creationMode = "feishu-first";
          return patch;
        },

        create_gitea_issues: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const created = [...(s.created ?? [])];
          const clarify = [...(s.clarify ?? [])];
          let processed = 0;
          for (const x of s.scoped ?? []) {
            if (x.dup || x.done) continue;
            const c = x.candidate;
            const repo = assignRepoForPool(c, x.pool);
            if (!repo) {
              clarify.push({ chatId: x.chatId, item: addPendingCandidate(x.chatId, c, x.pool, x.texts) });
              x.done = true;
              processed++;
              continue;
            }
            const r = await callGitea(ctx, {
              action: "create_issue",
              repo,
              title: `[${c.priority}] ${c.title}`,
              body: buildIssueBody(c.reason, x.texts, c.sources, x.chatId, await resolveChatName(ctx, x.chatId)),
            });
            if (r && typeof r.data === "object" && r.data !== null) {
              const issue = r.data as { number?: number; html_url?: string };
              created.push({ chatId: x.chatId, line: `${repo}#${issue.number ?? "?"} [${c.priority}] ${c.title}` });
              x.done = true;
              processed++;
              // ── C 方案双建：自动建单 → 同步飞书任务挂 org 清单 ──
              // 单一真相：复用 @orchestration/task-issue-sync 的 sync-issue 原语；
              // 同步失败只记日志不阻断流水线（工单已建，真人可见）
              try {
                const sr = (await ctx.call(taskIssueSyncRef, {
                  mode: "sync-issue",
                  repo,
                  issue,
                  sourceChatId: x.chatId === "*" ? undefined : x.chatId,
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
            // 建单失败（Gitea 不可达等）不标 done：digest 会作为未处理候选显性播报
            // （旧版此处静默丢弃）
          }
          const patch: Partial<PipelineState> = { created, clarify };
          if (processed > 0 && !s.creationMode) patch.creationMode = "legacy";
          return patch;
        },

        build_digest: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          const scoped = s.scoped ?? [];
          const created = s.created ?? [];
          const clarify = s.clarify ?? [];
          const dupCount = scoped.filter((x) => x.dup).length;
          const unhandled = scoped.filter((x) => !x.dup && !x.done);
          const messages: OutboundMessage[] = [];
          const targetFor = (chatId: string): string | undefined =>
            request.notifyChatId || (chatId === "*" ? undefined : chatId);
          // 来源措辞：播报统一进 notifyChatId（机器人群），「本群」不再成立——
          // 按消息来源区分「群聊讨论/私聊汇报」（chatId 判定不了 LLM 漏判时回退群聊）
          const labelByChat = new Map(
            (s.judged ?? []).map((j) => [j.chatId, j.chatType === "p2p" ? "私聊汇报" : "群聊讨论"]),
          );
          const srcLabel = (chatId: string): string => labelByChat.get(chatId) ?? "群聊讨论";

          // 有建单节点执行过 → 沿用对应措辞；建单全禁用 → 纯摘要
          const createdLines = new Map<string, string[]>();
          for (const { chatId, line } of created) {
            const list = createdLines.get(chatId) ?? [];
            list.push(line);
            createdLines.set(chatId, list);
          }
          for (const [chatId, lines] of createdLines) {
            const summaryMsg =
              s.creationMode === "legacy"
                ? `🆕 汇总：从${srcLabel(chatId)}里整理出 ${lines.length} 条任务，已建工单：\n` +
                  lines.map((t) => `• ${t}`).join("\n") +
                  `\n\n请回复「安排执行者 #工单号 @姓名」指定执行者；安排好执行者的任务才会进入执行队列。`
                : `🆕 汇总：从${srcLabel(chatId)}里整理出 ${lines.length} 条任务，已建飞书任务并归入对应清单「P 计划中」：\n` +
                  lines.map((t) => `• ${t}`).join("\n") +
                  `\n\n请回复「任务归属 编号 @仓库」确认归属、「安排执行者 编号 @姓名」确认执行者；两者齐备后自动创建 Gitea 工单。`;
            const target = targetFor(chatId);
            if (target) {
              messages.push({
                target,
                text: summaryMsg,
                titles: created.filter((c) => c.chatId === chatId).map((c) => c.line),
              });
            }
          }
          const clarifyByChat = new Map<string, ClarifyEntry[]>();
          for (const x of clarify) {
            const list = clarifyByChat.get(x.chatId) ?? [];
            list.push(x);
            clarifyByChat.set(x.chatId, list);
          }
          for (const [chatId, items] of clarifyByChat) {
            const poolNames = [...new Set(items.flatMap((x) => x.item.pool))].join(" / ");
            const msg =
              s.creationMode === "legacy"
                ? `❓ 从${srcLabel(chatId)}识别到 ${items.length} 条疑似任务，但归属仓库拿不准（候选：${poolNames}）：\n` +
                  items.map((x) => `${x.item.no}. [${x.item.priority}] ${x.item.title}`).join("\n") +
                  `\n\n回复「任务归属 编号 @仓库名」创建工单，回复「跳过任务 编号」丢弃。`
                : `❓ 从${srcLabel(chatId)}识别到 ${items.length} 条疑似任务，归属仓库拿不准（候选：${poolNames}），已先归入「P 计划中」：\n` +
                  items.map((x) => `${x.item.no}. [${x.item.priority}] ${x.item.title}`).join("\n") +
                  `\n\n回复「任务归属 编号 @仓库」确认归属、「安排执行者 编号 @姓名」确认执行者；两者齐备后自动创建 Gitea 工单。回复「跳过任务 编号」丢弃。`;
            const target = targetFor(chatId);
            if (target) {
              messages.push({
                target,
                text: msg,
                items: items.map((x) => ({ no: x.item.no })),
                titles: items.map((x) => x.item.title),
              });
            }
          }
          const unhandledByChat = new Map<string, ScopedCandidate[]>();
          for (const x of unhandled) {
            const list = unhandledByChat.get(x.chatId) ?? [];
            list.push(x);
            unhandledByChat.set(x.chatId, list);
          }
          for (const [chatId, items] of unhandledByChat) {
            // 摘要条目入澄清队列（digest-only 记录模式）：人工用「确认 N」/
            // 「任务归属 N 项目简称」/「安排执行者 N 姓名」核验或纠正判断。
            // 私聊/并集池（poolDefinite=false）的归属是全项目池里的低置信猜测，
            // 标 repoUncertain：「确认」不把它当已定项目，展示写「疑似」。
            const registered = items.map((x) =>
              request.notifyChatId
                ? addPendingCandidate(
                    x.chatId,
                    {
                      title: x.candidate.title,
                      priority: x.candidate.priority,
                      reason: x.candidate.reason,
                      sources: x.candidate.sources,
                      fromDigest: true,
                      suggestedRepo: x.candidate.repo,
                      suggestedExecutor: x.candidate.executor,
                      repoUncertain: x.poolDefinite === false,
                    },
                    x.pool,
                    x.texts,
                  )
                : undefined,
            );
            const chatName = await resolveChatName(ctx, chatId).catch(() => chatId);
            // ① 候选入台账（digest-only 记录模式）：获得 R 短码，播报/回复统一用 R 码
            const reg = request.registry;
            const reviewCodes = request.reviewCodeFile ? loadReviewCodes(request.reviewCodeFile) : {};
            const codeOfIdx = new Map<number, string>();
            if (reg) {
              for (const [i, x] of items.entries()) {
                const rec = reg.adopt({
                  title: x.candidate.title,
                  description: (x.texts ?? []).join("\n"),
                  origin: { provider: "chat-digest", guid: `${chatId}#${registered[i]?.no ?? i}` },
                  projectRef: x.candidate.repo ?? undefined,
                });
                const code =
                  Object.entries(reviewCodes).find(([, u]) => u === rec.uid)?.[0] ??
                  nextReviewCode(reviewCodes);
                reviewCodes[code] = rec.uid;
                codeOfIdx.set(i, code);
              }
              if (request.reviewCodeFile) saveReviewCodes(request.reviewCodeFile, reviewCodes);
            }
            // ② 播报分流（2026-10-05 负责人确认）：TiMEM 组织项目 → issue反馈群；
            // 其他项目/未定 → 私信负责人。每条候选按归属独立判定。
            const TIMEM_PREFIX = "TiMEM-AI/";
            const destOf = (x: (typeof items)[number]): "timem" | "owner" => {
              const repo = x.candidate.repo;
              if (repo && repo.startsWith(TIMEM_PREFIX)) return "timem";
              const poolRepos = x.pool ?? [];
              if (poolRepos.length > 0 && poolRepos.every((r) => r.startsWith(TIMEM_PREFIX))) return "timem";
              return "owner";
            };
            const fmtItem = (x: (typeof items)[number], i: number): string => {
              const code = codeOfIdx.get(i);
              const repo =
                x.poolDefinite === false
                  ? `❓ 待定${x.candidate.repo ? `（疑似 ${x.candidate.repo}）` : ""}`
                  : x.candidate.repo || "❓ 待定";
              const executor = x.candidate.executor || "❓ 待定";
              const srcPick = (x.candidate.sources ?? [])
                .map((n) => n - 1)
                .filter((idx) => idx >= 0 && idx < (x.texts?.length ?? 0))
                .slice(0, 2);
              const clue = (srcPick.length > 0 ? srcPick : (x.texts ?? []).map((_, idx) => idx))
                .slice(0, 2)
                .map((idx) => (x.texts?.[idx] ?? "").replace(/\n/g, " ").slice(0, 80))
                .filter(Boolean)
                .join(" ｜ ");
              return (
                `${code ?? `#${registered[i]?.no ?? i + 1}`} [${x.candidate.priority}] ${x.candidate.title}${x.candidate.reason ? ` —— ${x.candidate.reason}` : ""}\n` +
                `   项目：${repo} · 执行人：${executor}` +
                (clue ? `\n   线索原文：${clue}` : "")
              );
            };
            const buckets: Record<"timem" | "owner", Array<{ item: (typeof items)[number]; idx: number }>> = { timem: [], owner: [] };
            items.forEach((x, idx) => buckets[destOf(x)].push({ item: x, idx }));

            // TiMEM 桶 → issue反馈群
            if (buckets.timem.length > 0 && targetFor(chatId)) {
              const timemMsg =
                `📋 汇总：从「${chatName}」的${srcLabel(chatId)}里整理出 ${buckets.timem.length} 条疑似任务/待办：\n` +
                buckets.timem.map(({ item, idx }) => fmtItem(item, idx)).join("\n") +
                `\n\n（我的判断对吗？对的回复「确认 R编号（如 R12）」；要改就回复「任务归属 #编号 项目简称」「安排执行者 #编号 姓名」，多条可分行或直接连写；引用本条摘要回复时编号可省略。项目简称如 太忆/nx/电信平台。现阶段仅记录，不建任务/工单）`;
              messages.push({
                target: targetFor(chatId)!,
                text: timemMsg,
                items: buckets.timem.map(({ idx }) => ({ no: registered[idx]?.no })),
                titles: buckets.timem.map(({ item }) => item.candidate.title),
              });
            }

            // 非 TiMEM 桶 → 私信负责人
            if (buckets.owner.length > 0) {
              const ownerMsg =
                `📋 汇总：从「${chatName}」的${srcLabel(chatId)}里整理出 ${buckets.owner.length} 条疑似任务/待办（非 TiMEM 项目）：\n` +
                buckets.owner.map(({ item, idx }) => fmtItem(item, idx)).join("\n") +
                `\n\n（每天最多一次；处理完自动停止）`;
              const johnny = identityMembers(getIdentityRegistry()).find((m: { member_id: string }) => m.member_id === "member-johnny");
              const johnnyId = johnny?.feishu_open_ids?.[0];
              if (!johnnyId) {
                console.error("[task-pipeline] johnny 未绑定飞书，非 TiMEM 候选无法私信（已跳过）");
              } else {
                const r = (await ctx.call(feishuApiRef, {
                  method: "POST",
                  path: "/open-apis/im/v1/messages",
                  query: { receive_id_type: "open_id" },
                  identity: "tenant",
                  body: { receive_id: johnnyId, msg_type: "text", content: JSON.stringify({ text: ownerMsg }) },
                })) as { ok: boolean; value?: { code?: number }; error?: string };
                if (!r.ok || (r.value?.code ?? -1) !== 0) {
                  console.error(`[task-pipeline] 私信负责人失败: ${r.ok ? r.value?.code : r.error}`);
                }
              }
            }
          }
          // 观测日志（建单口径沿用旧版 + digest-only 口径）
          if (created.length > 0 || clarify.length > 0) {
            console.log(
              `[task-pipeline] ${s.creationMode === "legacy" ? "新建工单" : "飞书先行：新建计划任务"} ${
                created.length + clarify.length
              } 条（其中待澄清归属 ${clarify.length} 条），重复跳过 ${dupCount} 条`,
            );
          } else if (unhandled.length > 0) {
            console.log(`[task-pipeline] digest-only 汇总 ${unhandled.length} 条候选（重复跳过 ${dupCount} 条）`);
          } else if (scoped.length > 0) {
            console.log(`[task-pipeline] 判定 ${scoped.length} 条候选，全部与现有任务/工单重复`);
          }
          return { messages };
        },

        broadcast_digest: async (s: PipelineState): Promise<Partial<PipelineState>> => {
          for (const m of s.messages ?? []) {
            if (!m.target) continue;
            if (!notifySend) continue;
            try {
              // send 返回消息 id：摘要要跟「引用回复省略编号」的定位映射绑定
              const mid = await notifySend(m.target, m.text);
              if (mid) {
                const nos = (m.items ?? []).map((i) => i.no).filter((n): n is number => typeof n === "number");
                if (nos.length > 0) recordDigestMessage(mid, nos);
              }
              if (m.titles?.length) recordDigestTitles(m.titles);
            } catch (e) {
              console.error(`[task-pipeline] notify failed: ${String(e)}`);
            }
          }
          return {};
        },
      };

      // ── 数据面执行：每轮重新加载 YAML（改文件即生效）→ 校验 → 沿边执行 ──
      const runWorkflow = async (): Promise<void> => {
        const { doc, source } = loadPipelineDoc(workflowFile);
        const wf = new YamlWorkflow<PipelineState>(doc);
        wf.registerNodes(nodeFns);
        const v = wf.validate();
        if (v.errors.length > 0) {
          console.error(`[task-pipeline] 工作流校验失败(${source}), 本轮跳过: ${v.errors.join("; ")}`);
          return;
        }
        const r = await wf.run({ batch: [], requeue: [], judged: [], scoped: [], created: [], clarify: [], messages: [] });
        // LLM 不可用的消息放回缓冲头部，下个 tick 重试
        if (r.state.requeue.length > 0) {
          buffer.unshift(...r.state.requeue);
          if (buffer.length > bufferLimit) buffer.length = bufferLimit;
        }
        if (r.errors.length > 0) {
          console.error(`[task-pipeline] 工作流执行异常(${source}): ${r.errors.join("; ")}`);
        }
        console.log(
          `[task-pipeline] run(${doc.name}, ${source === "builtin" ? "builtin" : "yaml"}) ` +
            `path=${r.path.join("→") || "(空)"} 禁用=[${r.skipped.join(",")}] 批次=${r.state.batch.length}条`,
        );
      };

      const tick = async (): Promise<void> => {
        runtime.lastRunTs = Date.now();
        try {
          // ── 一批群消息的处理 = 数据面工作流（缓冲有消息才触发） ──
          if (buffer.length > 0) await runWorkflow();

          // ── PR 轮询提醒（执行面周期职责，不上工作流） ──
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
  description: "编排规划层：群聊→整理→建单*→播报 数据面工作流（建单节点 enabled 可关）+ PR 提醒（只管理不执行）",
  version: "1.1.0",
  provides: [taskPipelineService],
  consumes: [llmInferenceRef, feishuApiRef, giteaApiRef],
  preferredCarrier: CarrierKind.Thread,
};
