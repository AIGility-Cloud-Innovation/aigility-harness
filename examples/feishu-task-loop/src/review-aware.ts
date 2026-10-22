/**
 * review-aware — 「复核感知」包装人格（装配层专用，D5）
 *
 * 背景（2026-10-03 用户实测反馈）：复核清单发群后，用户自然回复
 * 「R01 执行人 yuxuanqing，归属项目是 opc」——正则意图匹配不上，
 * LLM 兜底又空响应，最终回退成帮助文本模板。
 *
 * 本插件作为 ingress 的人格路由入口，做两层事：
 *   1. 消息带复核短码（R01…，来自 review-session.ts 的会话文件）或
 *      「复核清单」查询 → 自然语言抽取要素（执行人/归属项目），落登记表、
 *      重跑五要素检查单，用人话回复结果；
 *   2. 其余消息原样透传 @persona/feishu-task-assistant，行为零变化。
 *
 * 设计取向：要素抽取用确定性正则 + 项目别名表（不烧 LLM、不猜），
 * 判定复用 task-release-gate（LLM 判现状/方法/目标），回复用确定性文案——
 * 固定的不是"格式"而是"事实"，宁可平实不可编造。
 *
 * 2026-10-07 句式扩展（真实事故 R42）：①归属抽取认「项目是 X」「仓库是 X」
 * 并支持 org/repo 全名；②带 R 码但码表没有 → 确定性提示，不再漏给单轮兜底。
 * 无编号/无短码的纯指代回复由 @persona/feishu-task-assistant 的短时记忆窗口兜。
 */
import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
  err,
  llmInferenceRef,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  LayerPlugin,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { existsSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskRegistry,
  runReleaseGate,
  loadReleaseDoc,
  SECTION_NAMES,
  FEISHU_TASK_PROVIDER_ID,
  GITEA_ISSUE_PROVIDER_ID,
  findPendingCandidateByNo,
  getIdentityRegistry,
  identityMembers,
  persistIdentityRegistry,
  identityRegistryPath,
  findMemberByFeishuOpenId,
} from "@aigility-harness/layer-orchestration";
import type { TaskRecord } from "@aigility-harness/core";
import type { ReleaseDoc } from "@aigility-harness/layer-orchestration";
import { resolveProjectRefAsync } from "./repo-resolver.js";
import { buildPendingIssuesReport } from "./pending-issues.js";

// ── 会话/登记表（与 scripts/review-session.ts 共用同一份文件） ──────

// 台账/会话/缓冲/审计一律落 config/*.local.*（gitignore 挡仓库）；/tmp 老文件自动迁移
const REPO_ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG_DIR = join(REPO_ROOT_DIR, "config");
const REGISTRY_FILE = process.env["REVIEW_REGISTRY_FILE"] ?? join(CONFIG_DIR, "task-registry.local.json");
const SESSION_FILE = process.env["REVIEW_SESSION_FILE"] ?? join(CONFIG_DIR, "review-session.local.json");
const NOTIFY_BUFFER_FILE = process.env["REVIEW_NOTIFY_BUFFER_FILE"] ?? join(CONFIG_DIR, "notify-buffer.local.json");
const AUDIT_FILE = process.env["REVIEW_AUDIT_FILE"] ?? join(CONFIG_DIR, "review-audit.local.jsonl");
const RELEASE_YAML = process.env["REVIEW_RELEASE_YAML"]
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "task-release.yaml");

let migrated = false;
function migrateLegacy(): void {
  if (migrated) return;
  migrated = true;
  const pairs: Array<[string, string]> = [
    ["/tmp/task-review-session.json", SESSION_FILE],
    ["/tmp/task-registry-review.json", REGISTRY_FILE],
    ["/tmp/task-notify-buffer.json", NOTIFY_BUFFER_FILE],
  ];
  for (const [from, to] of pairs) {
    if (existsSync(from) && !existsSync(to)) {
      try {
        copyFileSync(from, to);
        console.log(`[review-aware] 台账迁移 ${from} → ${to}`);
      } catch (e) {
        console.error(`[review-aware] 迁移失败 ${from}: ${String(e)}`);
      }
    }
  }
}

/** 轻量审计（JSONL 追加）：绑定/放行等敏感动作留痕 */
function audit(action: string, detail: Record<string, unknown>): void {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + "\n");
  } catch (e) {
    console.error(`[review-aware] 审计写入失败: ${String(e)}`);
  }
}

interface ReviewSession {
  codes: Record<string, string>;
  registryFile: string;
}

// 进程内单例：避免 1s 落盘窗口内多消息各自从旧文件重载、互相覆盖
let sharedRegistry: TaskRegistry | null = null;

/** 机器人进程内唯一的登记表实例（aligner / 复核人格共用，写者唯一） */
export function getSharedRegistry(): TaskRegistry {
  if (!sharedRegistry) {
    migrateLegacy();
    sharedRegistry = new TaskRegistry(REGISTRY_FILE);
    sharedRegistry.recover();
  }
  return sharedRegistry;
}

export function getReviewCodes(): Record<string, string> {
  migrateLegacy();
  try {
    const parsed = JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as Record<string, unknown>;
    // 兼容两种格式：新=平面 {R01: uid}；旧（broadcast 脚本遗产）={codes: {...}, registryFile}
    if (parsed && typeof parsed === "object" && "codes" in parsed && typeof parsed.codes === "object" && parsed.codes) {
      return parsed.codes as Record<string, string>;
    }
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveReviewCodes(codes: Record<string, string>): void {
  writeFileSync(SESSION_FILE, JSON.stringify(codes, null, 2));
}

/** 给尚无短码的 planned 任务续号发码（对齐器 onReport / 广播用） */
export function assignReviewCodes(registry: TaskRegistry): Array<{ code: string; title: string }> {
  const codes = getReviewCodes();
  let next =
    Object.keys(codes).reduce((max, k) => Math.max(max, Number(k.replace(/^R/, "")) || 0), 0) + 1;
  const taken = new Set(Object.values(codes));
  const out: Array<{ code: string; title: string }> = [];
  for (const r of registry.list({ status: ["planned"] })) {
    if (taken.has(r.uid)) continue;
    const code = `R${String(next).padStart(2, "0")}`;
    next += 1;
    codes[code] = r.uid;
    out.push({ code, title: r.title });
  }
  if (out.length > 0) saveReviewCodes(codes);
  return out;
}

function loadContext(): { registry: TaskRegistry } | null {
  if (!existsSync(SESSION_FILE) || !existsSync(REGISTRY_FILE)) return null;
  try {
    // 短码每次实时读（对齐器会持续续号），登记表用进程内单例
    return { registry: getSharedRegistry() };
  } catch {
    return null;
  }
}

// ── 项目别名解析（config/project-registry.json 的宽松匹配） ─────────

interface ProjectEntry {
  project_id: string;
  name: string;
  aliases?: string[];
  gitea_repos?: string[];
}

function loadProjects(): ProjectEntry[] {
  try {
    // src/ → feishu-task-loop → examples → 仓库根
    const root = process.env["REPO_ROOT"]
      ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const reg = JSON.parse(readFileSync(`${root}/config/project-registry.json`, "utf-8")) as {
      projects: ProjectEntry[];
    };
    return reg.projects ?? [];
  } catch {
    return [];
  }
}

/** "opc" → 命中的 org/repo；多命中/零命中返回 undefined 并给出候选
 *  2026-10-08 增强：别名表不含 org/repo 全名——「timem-ai/timem_console_frontend」
 *  这类全名/片段以前会在别名门被拦死；且用户常把下划线写成连字符。现对仓库名做
 *  -/_ 归一化直配（唯一命中才采纳，多命中不猜）。导出供回归测试。 */
export function resolveProjectRef(token: string): { repo?: string; candidates: string[] } {
  const t = token.trim().toLowerCase();
  if (!t) return { candidates: [] };
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, "");
  const tn = norm(t);
  const hits = new Set<string>();
  for (const p of loadProjects()) {
    const hay = [p.project_id, p.name, ...(p.aliases ?? [])].join("\n").toLowerCase();
    const repos = p.gitea_repos ?? [];
    if (hay.includes(t)) {
      for (const repo of repos) {
        if (repo.toLowerCase().includes(t) || repos.length === 1) hits.add(repo);
      }
    }
    // 仓库直配：别名没中但某个仓库名（归一化后）包含 token → 唯一命中才采纳
    const repoHits = repos.filter((r) => norm(r).includes(tn));
    if (repoHits.length === 1) repoHits.forEach((r) => hits.add(r));
  }
  const candidates = [...hits];
  return candidates.length === 1 ? { repo: candidates[0], candidates } : { candidates };
}

// ── 要素抽取（确定性正则，不烧 LLM） ────────────────────────────────

function extractExecutor(text: string): string | undefined {
  // 「执行人」「执行者」都认（2026-10-22：闸门文案教「安排执行者」，旧正则
  // 「执行人?」会把「者」当姓名开头吞进值 → 解析出「者张三」永远对不上人）
  const m = text.match(/执行[人者][：:]?\s*[@]?([\w\u4e00-\u9fa5·\-]{2,32})/);
  return m?.[1];
}
export { extractExecutor };

/** 执行人 = 编码代理（2026-10-08）：用户说「执行人 agent/AI/智能体」意为让 agent
 *  直接做，不指派人类——合法值，不触发人员台账匹配与私信提醒。 */
export function isAgentExecutor(token: string | undefined): boolean {
  return /^(agentd|agent|ai|ai代理|智能体|编码代理|代理)$/.test((token ?? "").trim().toLowerCase());
}

/** 归属抽取（2026-10-07 句式扩展）：真实事故「R42 项目是 timem_console_frontend」
 *  旧正则只认「归属(项目)是」，用户说「项目是 X」被当成补充材料、机器人仍回
 *  「还差归属」；现把 项目/仓库 也认作归属引导词，并支持 org/repo 全名（含 /）。
 *  注意「归属\s*(项目|仓库)?」必须整体可选链——否则「归属项目：X」会把「项目」
 *  吞成值。
 *  2026-10-08 再修（四连败事故）：「任务归属 R42 console」里 R 紧跟归属词，
 *  捕获组把 R42 当成归属值 → 永远解析失败。抽取前先剥短码。 */
export function extractProjectToken(text: string): string | undefined {
  const stripped = text.replace(/R\d{2,}/gi, " ");
  const m = stripped.match(/(?:归属\s*(?:项目|仓库)?|项目|仓库)(?:是|为|[:：])?\s*([\w\u4e00-\u9fa5/-]{2,64})/);
  return m?.[1];
}

// ── 飞书回写投影（放行成功 → 挪「D 执行中」分组） ───────────────────

type FeishuCallLike = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown };
  error?: string;
}>;

const FEISHU_API_REF = { id: "@action/feishu-api", versionRange: "^1.0.0" };
const TIMEM_MEMORY_REF = { id: "@action/timem-memory", versionRange: "^1.0.0" };
const TIMEM_WRITE_REF = { id: "@action/timem-memory-write", versionRange: "^1.0.0" };

function feishuCallVia(ctx: SeamContext): FeishuCallLike {
  return async (req) =>
    (await ctx.call(FEISHU_API_REF, req)) as {
      ok: boolean;
      value?: { code?: number; msg?: string; data?: unknown };
      error?: string;
    };
}

async function callData<T>(call: FeishuCallLike, req: Record<string, unknown>): Promise<T | undefined> {
  const r = await call(req);
  if (!r.ok || (r.value?.code ?? -1) !== 0) return undefined;
  return r.value?.data as T;
}

/**
 * 放行投影：找到记录对应的飞书任务（links/origin），挪进所在清单的
 * 「D 执行中」分组（分组缺则建）。工单先行的记录暂无飞书镜像 → 返回 null
 * （回建任务属后续投影）。返回给回复文案追加的说明，null = 无可投影。
 */
/** 确保清单存在「D 执行中」分组，返回 guid；缺且建失败返回 undefined */
async function ensureDoingSection(call: FeishuCallLike, listGuid: string): Promise<string | undefined> {
  const secs =
    (await callData<{ items?: Array<{ guid?: string; name?: string }> }>(call, {
      path: "/open-apis/task/v2/sections",
      query: { resource_type: "tasklist", resource_id: listGuid, page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
  const existing = secs.find((s) => (s.name ?? "").trim() === SECTION_NAMES.doing)?.guid;
  if (existing) return existing;
  const cr = await call({
    method: "POST",
    path: "/open-apis/task/v2/sections",
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { name: SECTION_NAMES.doing, resource_type: "tasklist", resource_id: listGuid },
  });
  return cr.ok && (cr.value?.code ?? -1) === 0
    ? (cr.value?.data as { section?: { guid?: string } })?.section?.guid
    : undefined;
}

/**
 * 工单先行回建（2026-10-04 与负责人确认的语义）：
 *   触发器 = 已放行 + 执行人已知 + 尚无飞书镜像。D 组只放"已指派"的任务，
 *   无主任务不建（裸确认放行但没指派 → 飞书侧静默，等补执行人那一刻）。
 *   建前按 [org/repo#N] 标题防重（有人手动建过则复用）；建后挂 links 幂等锁
 *   并挪「D 执行中」。返回给回复文案的说明，null = 触发条件未满足。
 */
export async function ensureFeishuMirror(
  call: FeishuCallLike,
  registry: TaskRegistry,
  uid: string,
): Promise<string | null> {
  const record = registry.get(uid);
  if (!record) return null;
  if (record.links["feishu-task"]) return null; // 已有镜像（幂等锁）
  if (record.status === "planned") return null; // 未放行不建
  if (!executorOf(record)) return null; // 未指派执行人不建（D 组只放已指派）
  const issueGuid = record.origin.provider === GITEA_ISSUE_PROVIDER_ID ? record.origin.guid : undefined;
  if (!issueGuid || !record.projectRef) return null;
  const org = record.projectRef.split("/")[0];

  // ① org 清单（约定：一个 Gitea 组织 = 一个清单）
  const lists =
    (await callData<{ items?: Array<{ name?: string; guid?: string }> }>(call, {
      path: "/open-apis/task/v2/tasklists",
      query: { page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
  const list = lists.find((l) => (l.name ?? "").trim() === org);
  if (!list?.guid) return `未找到「${org}」对应的飞书任务清单`;

  // ② D 分组
  const doingGuid = await ensureDoingSection(call, list.guid);
  if (!doingGuid) return "清单缺「D 执行中」分组且自动建失败";

  // ③ 防重：清单里已有 [org/repo#N] 前缀任务则复用
  const prefix = `[${issueGuid}]`;
  const all =
    (await callData<{ items?: Array<{ guid?: string; task_id?: string; summary?: string; url?: string }> }>(call, {
      path: `/open-apis/task/v2/tasklists/${list.guid}/tasks`,
      query: { completed: false, page_size: 100, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
  const dup = all.find((t) => (t.summary ?? "").startsWith(prefix));
  let taskGuid: string;
  let taskUrl: string | undefined;
  if (dup?.guid ?? dup?.task_id) {
    taskGuid = (dup!.guid ?? dup!.task_id)!;
    taskUrl = dup!.url;
  } else {
    const description = [
      record.origin.url ? `工单：${record.origin.url}` : `工单：${issueGuid}`,
      record.description ?? "",
      "（由项目小助理复核放行）",
    ]
      .filter(Boolean)
      .join("\n");
    const cr = await call({
      method: "POST",
      path: "/open-apis/task/v2/tasks",
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { summary: `${prefix} ${record.title}`, description },
    });
    if (!cr.ok || (cr.value?.code ?? -1) !== 0) {
      return `飞书建任务失败：${cr.ok ? cr.value?.msg : cr.error}`;
    }
    const task = (cr.value?.data as { task?: { guid?: string; url?: string } })?.task;
    if (!task?.guid) return "飞书建任务失败：未返回任务 guid";
    taskGuid = task.guid;
    taskUrl = task.url;
  }

  // ④ 挪 D + 挂镜像幂等锁
  const mv = await call({
    method: "POST",
    path: `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist`,
    query: { user_id_type: "open_id" },
    identity: "user",
    body: { tasklist_guid: list.guid, section_guid: doingGuid },
  });
  if (!mv.ok || (mv.value?.code ?? -1) !== 0) {
    return `任务已建（${taskGuid}）但挪「${SECTION_NAMES.doing}」失败：${mv.ok ? mv.value?.msg : mv.error}`;
  }
  registry.link(uid, "feishu-task", { guid: taskGuid, ...(taskUrl ? { url: taskUrl } : {}) });
  return dup ? `复用清单里已有的飞书任务，挪到「${SECTION_NAMES.doing}」` : `飞书任务已创建并进入「${SECTION_NAMES.doing}」`;
}

export async function projectReleaseToFeishu(
  call: FeishuCallLike,
  record: TaskRecord,
): Promise<string | null> {
  const guid =
    record.links["feishu-task"]?.guid ??
    (record.origin.provider === FEISHU_TASK_PROVIDER_ID ? record.origin.guid : undefined);
  if (!guid) return null;

  const lists =
    (await callData<{ items?: Array<{ guid?: string }> }>(call, {
      path: "/open-apis/task/v2/tasklists",
      query: { page_size: 50, user_id_type: "open_id" },
      identity: "user",
    }))?.items ?? [];
  for (const l of lists) {
    if (!l.guid) continue;
    const tasks =
      (await callData<{ items?: Array<{ guid?: string; task_id?: string }> }>(call, {
        path: `/open-apis/task/v2/tasklists/${l.guid}/tasks`,
        query: { completed: false, page_size: 100, user_id_type: "open_id" },
        identity: "user",
      }))?.items ?? [];
    if (!tasks.some((t) => (t.guid ?? t.task_id) === guid)) continue;

    const doingGuid = await ensureDoingSection(call, l.guid);
    if (!doingGuid) return "清单缺「D 执行中」分组且自动建失败";
    const mv = await call({
      method: "POST",
      path: `/open-apis/task/v2/tasks/${guid}/add_tasklist`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { tasklist_guid: l.guid, section_guid: doingGuid },
    });
    return (mv.ok && (mv.value?.code ?? -1) === 0)
      ? `飞书任务已挪到「${SECTION_NAMES.doing}」`
      : `飞书挪组失败：${mv.ok ? mv.value?.msg : mv.error}`;
  }
  return null;
}

// ── 执行人通知（姓名/别名 → 飞书 open_id → 机器人私信，带合并窗） ────

/** 精确匹配（绑定等敏感操作专用）：全名/别名/注册名完全一致 */
function findMemberExact(token: string) {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  return identityMembers(getIdentityRegistry()).find((m) =>
    [m.name, m.member_id, ...(m.aliases ?? [])].some((v) => (v ?? "").toLowerCase() === t),
  );
}

/** 模糊匹配（通知解析用）：精确优先，子串匹配仅唯一命中才采用 */
function findMemberFuzzyUnique(token: string): {
  member?: ReturnType<typeof identityMembers>[number];
  candidates?: Array<ReturnType<typeof identityMembers>[number]>;
} {
  const exact = findMemberExact(token);
  if (exact) return { member: exact };
  const t = token.trim().toLowerCase();
  if (!t) return {};
  const hits = identityMembers(getIdentityRegistry()).filter((m) =>
    [m.name, m.member_id, ...(m.aliases ?? [])].some((v) => (v ?? "").toLowerCase().includes(t)),
  );
  return hits.length === 1 ? { member: hits[0] } : { candidates: hits };
}

function executorOf(record: TaskRecord): string | undefined {
  return record.description?.match(/执行者：(\S+)/)?.[1];
}

/** 人员解析三件套：member_id ↔ 姓名 ↔ 飞书 open_id（人员台账为唯一映射源） */
function memberById(memberId: string | undefined) {
  if (!memberId) return undefined;
  return identityMembers(getIdentityRegistry()).find((m) => m.member_id === memberId);
}

function memberIdByOpenId(openId: string | undefined): string | undefined {
  if (!openId) return undefined;
  return findMemberByFeishuOpenId(getIdentityRegistry(), openId)?.member_id;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 记录是否归属某成员（结构化外键优先，历史描述文本兜底） */
function recordBelongsTo(record: TaskRecord, memberId: string, name: string, aliases: string[]): boolean {
  if (record.assignee_member_id === memberId) return true;
  const names = [name, ...aliases].filter(Boolean);
  return names.some((n) => new RegExp(`执行者：\\S*${escapeRegExp(n)}`).test(record.description ?? ""));
}

async function sendBotP2P(call: FeishuCallLike, openId: string, text: string): Promise<boolean> {
  const r = await call({
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "open_id" },
    identity: "tenant",
    body: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
  });
  return r.ok && (r.value?.code ?? -1) === 0;
}

/**
 * 频率策略（2026-10-04 与负责人确认）：
 *   · 私信只报"新工作落到你头上"（每次放行），状态流转不私信；
 *   · 同一执行人 quiet_window_minutes（默认 30 分钟）内的多条放行
 *     合并成一条 digest，防逐条轰炸；
 *   · 缓冲落盘（防重启丢窗），窗满由机器人进程发送；
 *   · 未绑定 open_id 的执行人不进窗，直接在群回复里给绑定指引。
 */

interface NotifyEntry {
  openId: string;
  name: string;
  records: Array<{ uid: string; title: string; projectRef?: string }>;
  firstAt: number;
}

type NotifyBuffer = Record<string, NotifyEntry>;

function loadNotifyBuffer(): NotifyBuffer {
  try {
    return JSON.parse(readFileSync(NOTIFY_BUFFER_FILE, "utf-8")) as NotifyBuffer;
  } catch {
    return {};
  }
}

function saveNotifyBuffer(buf: NotifyBuffer): void {
  writeFileSync(NOTIFY_BUFFER_FILE, JSON.stringify(buf, null, 2));
}

const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
let notifyCall: FeishuCallLike | null = null;

/** 待二次确认的绑定：senderId → 意图（10 分钟超时） */
interface PendingBind { memberId: string; name: string; at: number }
const pendingBinds = new Map<string, PendingBind>();
const BIND_CONFIRM_TIMEOUT_MS = 10 * 60_000;

function taskText(r: NotifyEntry["records"][number]): string {
  return `📌 有条任务等你执行：${r.title}${r.projectRef ? `（${r.projectRef}）` : ""}\n（复核已通过，进入「D 执行中」；有进展随时在项目群里说）`;
}

function digestText(e: NotifyEntry): string {
  return `📌 今天有 ${e.records.length} 条任务等你执行：\n${e.records
    .map((r, i) => `${i + 1}. ${r.title}${r.projectRef ? `（${r.projectRef}）` : ""}`)
    .join("\n")}\n（复核已通过，进入「D 执行中」；有进展随时在项目群里说）`;
}

async function flushExecutor(openId: string, windowMs: number): Promise<void> {
  notifyTimers.delete(openId);
  const buf = loadNotifyBuffer();
  const entry = buf[openId];
  if (!entry) return;
  delete buf[openId];
  saveNotifyBuffer(buf);
  if (!notifyCall) {
    // 机器人还没有可用的发送通道（理论罕见）：放回缓冲等下轮
    const b2 = loadNotifyBuffer();
    b2[openId] = entry;
    saveNotifyBuffer(b2);
    scheduleFlush(openId, windowMs);
    return;
  }
  const text = entry.records.length === 1 ? taskText(entry.records[0]!) : digestText(entry);
  const sent = await sendBotP2P(notifyCall, openId, text);
  if (!sent) console.error(`[review-aware] 合并私信发送失败: ${entry.name}`);
}

function scheduleFlush(openId: string, windowMs: number): void {
  if (notifyTimers.has(openId)) return;
  const entry = loadNotifyBuffer()[openId];
  if (!entry) return;
  const remain = Math.max(0, entry.firstAt + windowMs - Date.now());
  const t = setTimeout(() => void flushExecutor(openId, windowMs), remain);
  (t as unknown as { unref?: () => void }).unref?.();
  notifyTimers.set(openId, t);
}

function queueNotify(call: FeishuCallLike, openId: string, name: string, record: TaskRecord, windowMs: number): void {
  notifyCall = call;
  const buf = loadNotifyBuffer();
  const entry = buf[openId] ?? { openId, name, records: [], firstAt: Date.now() };
  entry.records.push({ uid: record.uid, title: record.title, projectRef: record.projectRef });
  buf[openId] = entry;
  saveNotifyBuffer(buf);
  scheduleFlush(openId, windowMs);
}

/** 每次消息处理开头调用：到窗的发送、没到窗的补挂定时器（进程重启自愈） */
function tickNotify(windowMs: number): void {
  const buf = loadNotifyBuffer();
  for (const openId of Object.keys(buf)) {
    if (Date.now() >= (buf[openId]?.firstAt ?? 0) + windowMs) void flushExecutor(openId, windowMs);
    else scheduleFlush(openId, windowMs);
  }
}

function notifyWindowMs(doc: ReleaseDoc): number {
  const cfg = doc.nodes?.["notify_executor"]?.config as Record<string, unknown> | undefined;
  const minutes = Number(cfg?.["quiet_window_minutes"] ?? 30);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 30 * 60_000;
}

/** 放行后通知执行人：绑定者进合并窗，未绑定回群内自助指引 */
async function notifyExecutorQueued(doc: ReleaseDoc, call: FeishuCallLike, record: TaskRecord): Promise<string | null> {
  const executor = executorOf(record);
  if (!executor) return null;
  const resolved = findMemberFuzzyUnique(executor);
  const member = resolved.member;
  const openId = member?.feishu_open_ids?.[0];
  if (isAgentExecutor(executor)) return "执行人是编码代理（agent），不发人工私信。";
  if (!member || !openId) {
    if (resolved.candidates && resolved.candidates.length > 1) {
      return `私信提醒没发出去：「${executor}」对上了几个人（${resolved.candidates.map((m) => m.name).join("、")}），写全名或补台账别名后重发。`;
    }
    return `私信提醒没发出去：「${executor}」还没绑定飞书身份——让他对机器人说「绑定身份 ${member?.name ?? executor}」即可，下次放行我直接私信他。`;
  }
  const nodeEnabledNotify = doc.nodes?.["notify_executor"]?.enabled !== false;
  const windowMs = notifyWindowMs(doc);
  if (!nodeEnabledNotify || windowMs === 0) {
    const sent = await sendBotP2P(call, openId, taskText({ uid: record.uid, title: record.title, projectRef: record.projectRef }));
    return sent ? `已飞书私信通知 ${member.name} 📩` : `私信发送失败（检查应用对 ${member.name} 的可见范围），先在群里喊他吧。`;
  }
  queueNotify(call, openId, member.name, record, windowMs);
  return `私信已排队（${Math.round(windowMs / 60_000)} 分钟内合并发送 📱）`;
}

// ── 服务契约（与 @persona/feishu-task-assistant 同形） ──────────────

interface AssistantRequest {
  user_input?: string;
  user_id?: string;
  session_id?: string;
  chat_type?: string;
  mentioned_bot?: boolean;
  /** 引用回复的消息 id（引用复核清单补充材料但忘写短码时用于引导） */
  root_id?: string;
}

interface AssistantResponse {
  response: string;
  agent_name: string;
  session_id: string;
  trace_id: string;
}

export const reviewAwareService: ServiceDefinition<AssistantRequest, AssistantResponse> = {
  id: "@persona/review-aware-assistant",
  version: "1.0.0",
  layer: LayerId.Persona,
  description:
    "复核感知包装人格：复核短码消息走自然语言补要素+放行；其余透传 @persona/feishu-task-assistant",
};

const DELEGATE_REF = { id: "@persona/feishu-task-assistant", versionRange: "^1.0.0" };
const GITEA_API_REF = { id: "@action/gitea-api", versionRange: "^1.0.0" };

export async function handleReviewMessage(
  text: string,
  ctx: SeamContext,
  senderId?: string,
): Promise<string | null> {
  const env = loadContext();
  if (!env) return null;
  const { registry } = env;
  const codes = getReviewCodes();
  const feishuCall = feishuCallVia(ctx);
  const fcall = async (req: Record<string, unknown>) => {
    const r = (await ctx.call(FEISHU_API_REF, req)) as {
      ok: boolean;
      value?: { code?: number; msg?: string; data?: unknown };
      error?: string;
    };
    return r.ok && r.value?.code === 0 ? r.value?.data : { code: r.value?.code, msg: r.value?.msg, error: r.error };
  };
  tickNotify(notifyWindowMs(loadReleaseDoc(RELEASE_YAML).doc));

  // 绑定身份（两步确认 + 本人绑定优先）：「绑定身份 X」→「确认绑定 X」
  const bindReq = text.match(/^(?:绑定身份|身份绑定)\s*[:：]?\s*(\S{1,32})$/);
  if (bindReq) {
    if (!senderId) return "绑定身份得让我知道你是谁——请在群聊里 @我 或私聊发送。";
    const exact = findMemberExact(bindReq[1]);
    if (!exact) {
      const fz = findMemberFuzzyUnique(bindReq[1]);
      if (fz.member) return `你是想绑定「${fz.member.name}」吗？回复「绑定身份 ${fz.member.name}」（全名）继续。`;
      if (fz.candidates && fz.candidates.length > 1) {
        return `「${bindReq[1]}」能对上几个人：${fz.candidates.map((m) => m.name).join("、")}——发全名指定一个。`;
      }
      return `人员台账里没有「${bindReq[1]}」，先在智悦平台「身份对齐」加成员，再来绑定。`;
    }
    if (exact.feishu_open_ids?.includes(senderId)) return `你的飞书已经绑定到「${exact.name}」了，不用重复绑。`;
    pendingBinds.set(senderId, { memberId: exact.member_id, name: exact.name, at: Date.now() });
    return [
      `确认一下：把你的飞书绑定到「${exact.name}」，之后安排给他的任务会私信到你这里。`,
      exact.feishu_open_ids?.length ? "（该成员已有绑定，确认后将替换原绑定）" : "",
      `回复「确认绑定 ${exact.name}」完成，10 分钟内有效。`,
    ].filter(Boolean).join("");
  }
  const bindConfirm = text.match(/^(?:确认绑定)\s*[:：]?\s*(\S{1,32})$/);
  if (bindConfirm) {
    if (!senderId) return "确认绑定得让我知道你是谁——请在群聊里 @我 或私聊发送。";
    const pending = pendingBinds.get(senderId);
    if (!pending || pending.name !== bindConfirm[1]) {
      return `没有待确认的绑定。先发「绑定身份 ${bindConfirm[1]}」发起，再回复「确认绑定 ${bindConfirm[1]}」。`;
    }
    if (Date.now() - pending.at > BIND_CONFIRM_TIMEOUT_MS) {
      pendingBinds.delete(senderId);
      return "绑定确认已超时（10 分钟），重新发「绑定身份 …」再来一次。";
    }
    const file = getIdentityRegistry();
    const target = file.members.find((m) => m.member_id === pending.memberId);
    if (!target) return "台账写入异常（成员缺失），稍后再试。";
    // 本人绑定优先：现有绑定若由绑定对象本人（binder == 被绑 open_id）设置，他人不可替换
    const meta = target.feishu_bind_meta;
    const selfBound = Boolean(meta?.by && target.feishu_open_ids?.[0] && meta.by === target.feishu_open_ids[0]);
    if (selfBound && meta!.by !== senderId) {
      return `「${target.name}」的现有绑定是本人设置的，其他人不能替换；如需变更请让本人操作。`;
    }
    const replaced = target.feishu_open_ids ?? [];
    target.feishu_open_ids = [senderId, ...(target.feishu_open_ids ?? [])];
    target.match_source = { ...target.match_source, feishu: "manual" };
    target.feishu_bind_meta = { by: senderId, at: new Date().toISOString() };
    const path = identityRegistryPath();
    if (!path) return "找不到人员台账文件路径，绑定失败。";
    persistIdentityRegistry(path, file);
    pendingBinds.delete(senderId);
    audit("bind", { member: target.name, by: senderId, replaced });
    return `好了 ✅ 你的飞书已绑定到「${target.name}」。以后任务安排给他，我直接私信通知你。`;
  }

  // 「#N」候选引用（digest 播报的编号 = pendingCandidates 编号）：查询/安排执行者
  const hashNos = [...text.matchAll(/[#＃]\s*(\d{1,3})/g)].map((m) => Number(m[1]));
  if (hashNos.length > 0) {
    const items = hashNos
      .map((no) => ({ no, item: findPendingCandidateByNo(no) }))
      .filter((x): x is { no: number; item: NonNullable<ReturnType<typeof findPendingCandidateByNo>> } => Boolean(x.item));
    if (items.length > 0) {
      const exec = text.match(/(?:安排执行者|指派执行者|执行人)\s*@?([\w\u4e00-\u9fa5·\-]{2,32})/);
      const lines: string[] = [];
      for (const { no, item } of items) {
        const title = (item.title ?? "").slice(0, 30);
        if (exec) {
          item.suggestedExecutor = exec[1];
          lines.push(`已记：#${no}「${title}」执行人 ${exec[1]}。候选还在记录阶段，要素齐备确认后建任务。`);
        } else {
          const repoHint = item.pool?.find((r) => r.startsWith("TiMEM-AI/")) ?? item.pool?.[0];
          lines.push(
            `#${no}「${title}」${repoHint ? `项目 ${repoHint}，` : ""}${
              item.suggestedExecutor ? `执行人 ${item.suggestedExecutor}，` : ""
            }待确认。`,
          );
        }
      }
      if (exec) {
        return lines.join("\n");
      }
      lines.push("", "要安排执行人就回复「安排执行者 #编号 姓名」。");
      return lines.join("\n");
    }
  }

  // 「取消 R0x」/「删除 R0x」→ 台账 cancelled + 飞书任务完结
  const cancelMatch = text.match(/^(?:取消|删除|作废)\s+(?:R\s?\d+|#\d+)\s*$/);
  if (cancelMatch) {
    const codeRef = text.match(/(?:R\s?\d+|#\d+)/)?.[0]?.replace(/\s/g, "");
    const uid = codeRef?.startsWith("R") ? codes[codeRef.replace(/^R/, "R")] : undefined;
    if (!uid) return `「${codeRef}」不在当前复核清单里。`;
    const tr = registry.transition(uid, "cancelled");
    if (!tr.ok) return `取消失败：${tr.error}`;
    // 飞书任务完结（从活跃看板消失）
    const rec = registry.get(uid)!;
    const guid = rec.links["feishu-task"]?.guid ?? (rec.origin.provider === FEISHU_TASK_PROVIDER_ID ? rec.origin.guid : undefined);
    if (guid) {
      await fcall({ method: "PATCH", path: `/open-apis/task/v2/tasks/${guid}`, query: { user_id_type: "open_id" }, identity: "user", body: { update_fields: ["completed_at"], task: { completed_at: String(Date.now()) } } });
    }
    return `✅ ${codeRef}「${rec.title.slice(0, 30)}」已取消（飞书任务同步完结）。`;
  }

  // 「XX 的任务 / XX 手上的活」——按人员台账反查名下任务（第三人称；「我的任务」仍走原人格全景）
  // 注意：仅匹配"整条消息就是查询"的形态（尾部无其他内容），避免劫持
  // 「把最近两天的任务情况整理发我」这类报告类请求。
  const whose = text.match(/^([\p{Script=Han}\w·\-]{2,16}?)(?:的|手上|名下)(?:所有|全部)?任务[，。！？!?\s]*$/u);
  if (whose && whose[1] !== "我") {
    const resolved = findMemberFuzzyUnique(whose[1]);
    const member = resolved.member;
    if (!member) {
      if (resolved.candidates && resolved.candidates.length > 1) {
        return `「${whose[1]}」对上了几个人：${resolved.candidates.map((m) => m.name).join("、")}——发全名。`;
      }
      return `人员台账里没有「${whose[1]}」。`;
    }
    const mine = registry.list().filter((r) => recordBelongsTo(r, member.member_id, member.name, member.aliases ?? []));
    if (mine.length === 0) return `「${member.name}」名下暂无任务。`;
    const doing = mine.filter((r) => r.status === "ready" || r.status === "dispatched" || r.status === "running");
    const review = mine.filter((r) => r.status === "review");
    const planned = mine.filter((r) => r.status === "planned");
    const fmt = (r: (typeof mine)[number]) => `  - ${r.title.slice(0, 32)}${r.projectRef ? `（${r.projectRef}）` : ""}`;
    const parts: string[] = [`「${member.name}」名下 ${mine.length} 条：`];
    if (doing.length) parts.push(`待执行/执行中 ${doing.length} 条：\n${doing.map(fmt).join("\n")}`);
    if (review.length) parts.push(`待验收 ${review.length} 条：\n${review.map(fmt).join("\n")}`);
    if (planned.length) parts.push(`规划中 ${planned.length} 条：\n${planned.map(fmt).join("\n")}`);
    return parts.join("\n");
  }

  // 「检查编号100」「#105 内容」——按工单号反查台账，简报回应（短话，不倒功能清单）
  const numRefs = [...text.matchAll(/(?:编号|#)\s*(\d{1,4})/g)].map((m) => m[1]!);
  if (numRefs.length > 0 && /检查|看看|内容|状态|什么情况|详情|进展/.test(text)) {
    const lines: string[] = [];
    for (const n of numRefs) {
      const rec = registry.list().find(
        (r) => r.origin.guid.endsWith(`#${n}`) || Boolean(r.links["gitea-issue"]?.guid.endsWith(`#${n}`)),
      );
      if (!rec) {
        lines.push(`#${n}：台账里没有对应任务（可能是已关闭的工单）。`);
        continue;
      }
      const missing = [!rec.projectRef ? "归属" : null, !/执行者：\S+/.test(rec.description ?? "") ? "执行人" : null]
        .filter(Boolean)
        .join("、");
      lines.push(
        `#${n}｜${rec.status}｜${rec.title.slice(0, 36)}${rec.projectRef ? ` @${rec.projectRef}` : ""}` +
          `${missing ? `（缺${missing}）` : ""}${rec.review ? ` 复核:${rec.review.by}` : ""}`,
      );
    }
    return lines.join("\n");
  }

  // 查询：复核清单（无短码也可查）
  // 2026-10-12：短码已进三位数时代（R100+），\d{2} 会把 R100 截成 R10 查无此任务
  //（实测用户发 R100 R101 被回「R10 的台账找不到了」×2）。改 \d{2,} 全兼容。
  const matchedCodes = [...text.matchAll(/R\d{2,}/gi)]
    .map((m) => m[0].toUpperCase())
    .filter((c) => c in codes);
  const wantsList = /复核清单|待复核|复核列表/.test(text) && matchedCodes.length === 0;
  if (matchedCodes.length === 0 && !wantsList) {
    // 2026-10-07：消息带 R 码但码表里没有（已放行/已刷新/写错）→ 确定性提示，
    // 不再静默漏给单轮兜底瞎答（真实事故：R42 那条问归属落兜底答非所问）
    const unknownCode = text.match(/[Rr]\d{2}/)?.[0]?.toUpperCase();
    if (unknownCode) {
      return `「${unknownCode}」不在当前复核清单里（可能已放行或清单刷新过）。发「复核清单」看现有短码。`;
    }
    return null;
  }

  if (wantsList) {
    // 2026-10-10 合并：与定时提醒共用同一套统计/行格式（pending-issues 单一事实源）——
    // 修复「复核清单永远只出前 10 条、与『43 条待处理』对不上」；支持翻页与全量。
    const pageSpec = text.match(/复核清单\s*(\d+|全部|all)/i)?.[1];
    return buildPendingIssuesReport(registry, codes, pageSpec);
  }

  // 要素抽取 + 落库
  const executor = extractExecutor(text);
  const projectToken = extractProjectToken(text);
  let projectRef: string | undefined;
  let projectAsk: string | undefined;
  if (projectToken) {
    // 两级解析（2026-10-10）：登记表未命中 → Gitea /repos/search 回落（「career」
    // 这类未登记仓库也能唯一命中；0/多命中才反问）
    const resolved = await resolveProjectRefAsync(projectToken, async (req) =>
      (await ctx.call(GITEA_API_REF, req)) as never, resolveProjectRef);
    if (resolved.repo) projectRef = resolved.repo;
    else if (resolved.candidates.length > 1) {
      projectAsk = `「${projectToken}」能对上几个仓库：${resolved.candidates.join("、")}，说一个具体的？`;
    } else {
      projectAsk = `「${projectToken}」我没对上登记表里的项目，说下完整的 org/仓库？`;
    }
  }
  // 除短码/结构要素外的正文 = 用户补充的材料（现状/目标/方法…），原样记入描述，
  // 检查单重跑时 LLM 判定的是"补过的描述"——这是"回复了还问"问题的修复核心。
  // （2026-10-07 与 extractProjectToken 同步扩展：归属/项目/仓库 三种引导词都要剥掉）
  const residual = text
    .replace(/R\d{2,}/gi, "")
    .replace(/执行[人者][：:]?\s*[@]?[\w\u4e00-\u9fa5·\-]{2,32}/, "")
    .replace(/(?:归属\s*(?:项目|仓库)?|项目|仓库)(?:是|为|[:：])?\s*[\w\u4e00-\u9fa5/-]{2,64}/, "")
    .trim();
  const hasSupplement = residual.length >= 4;

  const lines: string[] = [];
  for (const code of matchedCodes) {
    const uid = codes[code];
    const record = registry.get(uid);
    if (!record) {
      lines.push(`${code} 的台账找不到了（可能已放行或清单刷新过），发「复核清单」我看下。`);
      continue;
    }
    const applied: string[] = [];
    const patch: { projectRef?: string; description?: string; title?: string; assignee_member_id?: string } = {};
    if (projectRef) {
      patch.projectRef = projectRef;
      applied.push(`归属 ${projectRef}`);
    }
    if (executor && isAgentExecutor(executor)) {
      // 2026-10-22 修（用户转发记录实锤）：agent 执行 → 标题加【agent】前缀
      // （放行闸门 2026-10-20 收敛后 agent 唯一认定=标题前缀，仅写「执行者：agent」
      // 描述标记会被判 missing → 用户补了却永远「还差执行人」的死循环）。
      const bare = (record.title ?? "").replace(/^【agent】/, "").replace(/^【(待安排执行者|待确认归属)】/, "");
      patch.title = `【agent】${bare}`;
      if (!/执行者：\S+/.test(record.description ?? "")) {
        patch.description = `${record.description ?? record.title}\n执行者：agent`;
      }
      applied.push("执行人 agent（标题【agent】）");
    } else if (executor && !/执行者：\S+/.test(record.description ?? "")) {
      patch.description = `${record.description ?? record.title}\n执行者：${executor}`;
      applied.push(`执行人 ${executor}`);
      const mem = findMemberFuzzyUnique(executor).member;
      if (mem) patch.assignee_member_id = mem.member_id; // 结构化外键（解析失败留空，不阻塞）
    } else if (executor) {
      // 2026-10-22 修：已有旧「执行者：X」标记 → 覆盖新值（此前静默丢弃，
      // 旧值哪怕写错用户也永远改不了，回复被无视只剩「还差」复读）。
      patch.description = (record.description ?? record.title).replace(/执行者[:：]\s*\S+/, `执行者：${executor}`);
      applied.push(`执行人改为 ${executor}`);
      const mem = findMemberFuzzyUnique(executor).member;
      if (mem) patch.assignee_member_id = mem.member_id;
    }
    if (hasSupplement) {
      patch.description = `${patch.description ?? record.description ?? record.title}\n〔补充〕${residual}`;
      applied.push(`补充材料 ${residual.slice(0, 20)}${residual.length > 20 ? "…" : ""}`);
    }
    if (Object.keys(patch).length > 0) registry.update(uid, patch);

    const doc = loadReleaseDoc(RELEASE_YAML).doc;
    const llm = async (r: { system: string; user: string }) => {
      const res = (await ctx.call(llmInferenceRef, {
        // 2026-10-12 负责人指定：小助理 LLM 统一 ksyun-deepseek-v4.1-flash
        //（原 ksyun-qwen3.7-flash / qwen-turbo 均为旧网关结论；max_tokens 300 回复
        // 只剩套话的坑见 git 历史——1500 与 persona 兜底同款，推理 token 余量）。
        // TASK_REVIEW_MODEL 可覆盖。
        model: process.env["TASK_REVIEW_MODEL"] || "ksyun-deepseek-v4.1-flash",
        messages: [
          { role: "system", content: r.system },
          { role: "user", content: r.user },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      })) as { ok: boolean; value?: { text?: string }; error?: string };
      return res.ok
        ? ({ ok: true, value: { text: res.value?.text ?? "" } } as const)
        : ({ ok: false, error: res.error ?? "llm failed" } as const);
    };

    // 放行后统一出口：飞书先行→挪 D；工单先行→已指派则回建 D 任务；执行人→私信
    // ① 描述同步回写飞书：台账富化后的描述（现状/目标/补充材料）→ 飞书任务 description
    const syncDescription = async (rec: TaskRecord): Promise<void> => {
      const guid = rec.links["feishu-task"]?.guid ?? (rec.origin.provider === FEISHU_TASK_PROVIDER_ID ? rec.origin.guid : undefined);
      if (!guid || !rec.description) return;
      try {
        await fcall({
          method: "PATCH",
          path: `/open-apis/task/v2/tasks/${guid}`,
          query: { user_id_type: "open_id" },
          identity: "user",
          body: { update_fields: ["description"], task: { description: rec.description } },
        });
      } catch (e) {
        console.error(`[review-aware] 描述回写飞书失败: ${String(e)}`);
      }
    };

    const postRelease = async (code: string, uid: string): Promise<string> => {
      const rec = registry.get(uid)!;
      const projection =
        rec.links["feishu-task"] || rec.origin.provider === FEISHU_TASK_PROVIDER_ID
          ? await projectReleaseToFeishu(feishuCall, rec)
          : await ensureFeishuMirror(feishuCall, registry, uid);
      // ② 描述同步回写飞书（台账富化后的全文 → 飞书任务 description）
      await syncDescription(registry.get(uid)!);
      const notify = await notifyExecutorQueued(doc, feishuCall, registry.get(uid)!);
      // 任务事件带结构化引用写入 timem（任务↔记忆关联：[task:uid] [project] [member] 可检索）
      const rec2 = registry.get(uid)!;
      const issueRef = rec2.links["gitea-issue"]?.guid ?? (rec2.origin.provider === GITEA_ISSUE_PROVIDER_ID ? rec2.origin.guid : undefined);
      void ctx
        .call(TIMEM_WRITE_REF, {
          content:
            `【任务放行】${code}「${rec2.title}」（${issueRef ?? rec2.uid}）复核人：${rec2.review?.by ?? "—"}；` +
            `执行人：${executorOf(rec2) ?? "未指派"}；已进入飞书「D 执行中」。描述：${(rec2.description ?? "").slice(0, 300)} ` +
            `[task:${rec2.uid}]${rec2.projectRef ? ` [project:${rec2.projectRef}]` : ""}${rec2.assignee_member_id ? ` [member:${rec2.assignee_member_id}]` : ""}`,
          agent_id: "feishu-task-assistant",
          domain: rec2.projectRef?.split("/")[0],
        })
        .then((w) => {
          if (!(w as { ok?: boolean }).ok) console.error("[review-aware] 任务事件写入 timem 失败");
        })
        .catch((e: Error) => console.error(`[review-aware] 任务事件写入 timem 异常: ${e.message}`));
      return `${projection ? `（${projection}）` : ""}${notify ? ` ${notify}` : ""}`;
    };

    // 裸确认（「确认 R01」/「放行 R01」，未附任何要素）= 人工一票放行
    const bareConfirm = /确认|放行|复核通过/.test(text) && !executor && !projectToken && !hasSupplement;
    if (bareConfirm) {
      const reviewerMemberId = memberIdByOpenId(senderId);
      const reviewer = memberById(reviewerMemberId)?.name ?? (senderId ? `feishu:${senderId.slice(-6)}` : "群内复核");
      const approved = registry.approve(uid, {
        via: "manual",
        by: reviewer,
        note: "群内裸确认",
        reviewer_member_id: reviewerMemberId,
      });
      if (!approved.ok) {
        lines.push(`${code} 放行失败：${approved.error}`);
        continue;
      }
      audit("approve", { uid, code, by: reviewer, via: "manual", member_id: reviewerMemberId });
      const suffix = await postRelease(code, uid);
      lines.push(`${code}「${record.title.slice(0, 30)}」已由 ${reviewer} 放行 ✅${suffix}`);
      continue;
    }

    // 经验召回：按任务内容检索相关记忆，注入检查单提示词（fail-open，不阻塞复核）
    let extraGuidance: string | undefined;
    try {
      const sr = (await ctx.call(TIMEM_MEMORY_REF, {
        query: `${record.title} ${(record.description ?? "").slice(0, 200)}`.trim(),
        agent_id: "feishu-task-assistant",
        limit: 3,
      })) as { ok: boolean; value?: { results?: Array<{ content: string }> }; error?: string };
      const items = sr.ok ? (sr.value?.results ?? []) : [];
      if (items.length > 0) {
        extraGuidance = items.map((r2) => `- ${String(r2.content).slice(0, 120)}`).join("\n");
      }
    } catch {
      // fail-open：召回不可用不阻塞复核
    }
    const gate = await runReleaseGate(registry, uid, doc, llm, { extraGuidance });
    if (!gate.ok) {
      lines.push(`${code} 检查没跑起来：${gate.error}`);
      continue;
    }
    const d = gate.value.decision;
    if (d.action === "auto-release") {
      audit("approve", { uid, code, by: "system", via: "auto" });
      const suffix = await postRelease(code, uid);
      lines.push(`${code}「${record.title.slice(0, 30)}」${applied.length ? `记好了：${applied.join("、")}。` : ""}五要素齐了，已自动放行 ✅${suffix} 接下来就可以安排执行。`);
    } else if (projectAsk) {
      lines.push(`${code} 收到${applied.length ? `，${applied.join("、")}已记。` : "。"}${projectAsk}`);
    } else {
      lines.push(`${code} 收到${applied.length ? `，${applied.join("、")}已记。` : ""}还差：${d.missing.join("、")} —— 直接打字发给我就行，我记下来重新检查。`);
    }
  }
  return lines.join("\n") || null;
}

export const reviewAwareProvider: Provider<AssistantRequest, AssistantResponse> = {
  service: reviewAwareService,
  name: "persona-review-aware",
  state: PluginState.Active,

  async execute(request: AssistantRequest, ctx: SeamContext): Promise<Result<AssistantResponse>> {
    const text = String(request.user_input ?? "");
    const handled = text ? await handleReviewMessage(text, ctx, request.user_id).catch((e: Error) => {
      console.error(`[review-aware] 处理失败, 透传人格: ${e.message}`);
      return null;
    }) : null;

    if (handled !== null) {
      return ok({
        response: handled,
        agent_name: "项目小助理",
        session_id: request.session_id ?? "",
        trace_id: `review-${request.session_id ?? "na"}`,
      });
    }

    // 引用回复但没写短码 + 像是补充材料 → 引导报短码，而不是丢给帮助模板
    if (
      request.root_id &&
      existsSync(SESSION_FILE) &&
      /现状|目标|方法|背景|验收|确认|补充|归属|执行/.test(text)
    ) {
      return ok({
        response: "收到，这条我想记到具体任务上——报一下短码（R01、R02…）？发「复核清单」可以看到全部。",
        agent_name: "项目小助理",
        session_id: request.session_id ?? "",
        trace_id: `review-${request.session_id ?? "na"}`,
      });
    }

    // 透传：行为与直连人格完全一致——但"答不上来回退超长帮助模板"替换成一句话
    const r = (await ctx.call(DELEGATE_REF, request as never)) as {
      ok: boolean;
      value?: AssistantResponse;
      error?: string;
    };
    if (r.ok && r.value) {
      const resp = r.value;
      const looksLikeHelpTemplate =
        resp.response.includes("我是「项目小助理」") && resp.response.length > 300;
      if (looksLikeHelpTemplate) {
        return ok({
          ...resp,
          response:
            "这个我答不上来，不瞎编。我的主场是任务复核和工单协同——报短码、发「复核清单」，或者直接说要把哪条任务怎么办。",
        });
      }
      return ok(resp);
    }
    return err(`review-aware: 人格透传失败 ${r.error ?? "unknown"}`);
  },

  async health(): Promise<HealthStatus> {
    const env = loadContext();
    return {
      healthy: true,
      detail: env ? `复核会话在线（${Object.keys(getReviewCodes()).length} 个短码）` : "无复核会话（纯透传模式）",
      checkedAt: new Date().toISOString(),
    };
  },
};

export const manifest: PluginManifest = {
  name: "@persona/review-aware-assistant",
  layer: LayerId.Persona,
  description: "复核感知包装人格：短码自然语言补要素/放行 + 复核清单查询，其余透传原人格",
  version: "1.0.0",
  provides: [reviewAwareService],
  consumes: [llmInferenceRef],
  preferredCarrier: CarrierKind.Thread,
};

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(): Promise<Result<void>> {
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [reviewAwareProvider];
  },
  getState(): PluginState {
    return PluginState.Active;
  },
};
