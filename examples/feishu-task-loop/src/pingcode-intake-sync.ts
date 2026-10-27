/**
 * pingcode-intake-sync — 飞书 P 组新卡 → PingCode 自动建单 + 落映射（2026-10-25 用户拍板）。
 *
 * 归属→项目（拍板口径）：
 *   TiMEM-AI/TiMEM-Space → TAI；TiMEM-AI 其他仓库 → TYY；
 *   AIGility-Cloud-Innovation 不做同步；解析不出归属（标题无 [org/repo]、台账无
 *   projectRef）跳过不建——错了宁可不建。
 * 触发：只认「进入 P 计划中」（board-projection 截面 P*）；已在映射表/已完成的卡跳过。
 * 已手工关联（描述含 aici.pingcode.com 工单链接）→ 只解析工单号落映射，不重复建单。
 * 建卡：「任务」类型（2026-10-21 拍板），描述带飞书链接与台账 uid；默认态=打开=P 映射态，
 *       建完由 pingcode-status-sync（①.56）接管后续状态。
 * 旁路：未配凭据/投影缺失/单条失败全部静默跳过，不阻塞对齐器（与 status-sync 同姿势）。
 * 防噪音：跳过原因记 state 文件（skip: 前缀），同卡同因不重复刷日志。
 *
 * 注意：pr-finisher 交付建的「已修复」缺陷卡刻意不进映射表——缺陷卡自管生命周期，
 * 若入表会被 ①.56 按 C 待测试 →「已提测」打（与「已修复」流转冲突，PATCH 静默失败空转）。
 *
 * PingCode API 事实（2026-10-23 实测，见 pingcode-status-sync 头注）：列表翻页已坏，
 * 查重/找卡用 keywords 检索；建单后 GET 回读 whole_identifier 再落映射。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { titleOfRepo } from "@aigility-harness/layer-orchestration";

const OPEN = "https://open.pingcode.com/v2";

/** 建单类型：通用「任务」而非「特性」（2026-10-21 用户拍板；/workitem_types 实测枚举）。 */
const TASK_TYPE_NAME = "任务";
const TASK_TYPE_ID_FALLBACK = "6628f44becf3cef770511507";
/** 单拍建单上限：首拍积压时分批消化，避免对 PingCode 突发写。 */
const MAX_CREATE_PER_TICK = 8;
const PC_LINK_RE = /aici\.pingcode\.com\/pjm\/workitems\/([0-9a-f-]{8,})/;

/** 台账/注册表最小接口（结构化类型，便于单测注入假件）。 */
export interface IntakeRegistry {
  list(): Array<{
    uid: string;
    title?: string;
    description?: string;
    status?: string;
    projectRef?: string;
    links?: Record<string, { guid?: string }>;
    origin?: { provider: string; guid?: string };
  }>;
}

/** 飞书卡 guid：links 优先，origin 回落（与 review-aware 取法一致）。 */
export function feishuGuidOf(t: {
  links?: Record<string, { guid?: string }>;
  origin?: { provider: string; guid?: string };
}): string | undefined {
  return t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
}

/** 归属解析：台账 projectRef 优先（repo-resolver 权威），标题 [org/repo] 回落。 */
export function resolveAttribution(t: { title?: string; projectRef?: string }): string | undefined {
  if (t.projectRef && t.projectRef.includes("/")) return t.projectRef;
  return titleOfRepo(t.title ?? "");
}

/**
 * 归属（org[/repo]）→ PingCode 项目标识（纯函数，单测覆盖）。
 * TiMEM-AI/TiMEM-Space→TAI；TiMEM-AI 其他→TYY；AIGility-Cloud-Innovation→不做同步；
 * 裸仓库名只认 timem-space→TAI（org 不明，其余不猜）；其余→不建。
 */
export function pcProjectForAttribution(attribution: string | undefined): "TAI" | "TYY" | undefined {
  if (!attribution) return undefined;
  const norm = (s: string) => s.trim().toLowerCase().replace(/[-_]/g, "");
  const [rawOrg, rawRepo] = attribution.includes("/") ? attribution.split("/", 2) : [undefined, attribution];
  if (rawOrg) {
    const org = norm(rawOrg);
    if (org === "aigilitycloudinnovation") return undefined; // 整个组织不做同步
    if (org === "timemai") {
      return norm(rawRepo ?? "") === "timemspace" ? "TAI" : "TYY";
    }
    return undefined; // 未知组织不猜
  }
  return norm(rawRepo) === "timemspace" ? "TAI" : undefined;
}

interface MapEntry { feishu_guid: string; pingcode: string; feishu_summary?: string }

export interface IntakeResult {
  /** 本拍新建的 PC 单（`TYY-140「标题」`） */
  created: string[];
  /** 手工关联已存在的卡，本拍只落映射（`TAI-12「标题」`） */
  linked: string[];
  /** 跳过（归属不明/AIGility 不建），仅首见记日志 */
  skipped: string[];
}

/**
 * 每拍入口：P 组未映射卡 → 建单/关联 + 落映射。返回结果描述（空=无事发生）。
 * 映射表缺失视为空表（首拍即创建）；凭据未配置直接返回空。
 */
export async function syncPingcodeIntake(
  registry: IntakeRegistry,
  repoRoot: string,
): Promise<IntakeResult> {
  const empty: IntakeResult = { created: [], linked: [], skipped: [] };
  const cid = process.env.PINGCODE_CLIENT_ID, csec = process.env.PINGCODE_CLIENT_SECRET;
  if (!cid || !csec) return empty;
  const mapPath = process.env.PINGCODE_SYNC_MAP
    ? resolve(process.env.PINGCODE_SYNC_MAP)
    : resolve(repoRoot, "config/feishu-pingcode-sync.map.json");
  const projSection = (() => {
    try {
      return JSON.parse(
        readFileSync(resolve(repoRoot, "config/board-projection.local.json"), "utf-8"),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  let entries: MapEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(mapPath, "utf-8")) as MapEntry[];
  } catch { /* 缺失/坏表：按空表起（首拍创建） */ }
  const mapped = new Set(entries.map((e) => e.feishu_guid));

  // 候选：P 组 + 未映射 + 未完成（完成卡直接跳过不建）
  const candidates = registry
    .list()
    .filter((t) => (projSection[t.uid] ?? "").startsWith("P"))
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .filter((t) => {
      const guid = feishuGuidOf(t);
      return guid && !mapped.has(guid);
    });
  if (candidates.length === 0) return empty;

  // token 现取（短时效，与 status-sync 同姿势）
  const q = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec });
  let tok: string;
  try {
    tok = ((await (await fetch(`${OPEN}/auth/token?${q}`)).json()) as { access_token?: string }).access_token ?? "";
  } catch {
    return empty;
  }
  if (!tok) return empty;
  const PH = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

  const statePath = mapPath.replace(/\.json$/, ".state.json"); // 与 status-sync 共用
  let sigs: Record<string, string> = {};
  try {
    sigs = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
  } catch { /* 首拍无状态文件 */ }
  const noteSkip = (guid: string, reason: string, title: string) => {
    if (sigs[`skip:${guid}`] !== reason) {
      sigs[`skip:${guid}`] = reason;
      console.log(`[pingcode-intake] 跳过「${title.slice(0, 30)}」：${reason}`);
    }
  };

  // 项目/类型元数据缓存（本次运行内）
  const metaCache = new Map<string, { projectId: string; typeId: string } | undefined>();
  const getMeta = async (projIdent: string) => {
    const hit = metaCache.get(projIdent);
    if (hit !== undefined) return hit;
    try {
      const projs = ((await (await fetch(`${OPEN}/pjm/projects`, { headers: PH })).json()) as { values?: Array<{ id: string; identifier: string }> }).values ?? [];
      const proj = projs.find((x) => x.identifier === projIdent);
      if (!proj) {
        metaCache.set(projIdent, undefined);
        return undefined;
      }
      const types = ((await (await fetch(`${OPEN}/pjm/workitem_types?project_id=${proj.id}`, { headers: PH })).json()) as { values?: Array<{ id: string; name?: string }> }).values ?? [];
      const taskType = types.find((x) => x.name === TASK_TYPE_NAME) ?? { id: TASK_TYPE_ID_FALLBACK };
      const meta = { projectId: proj.id, typeId: taskType.id };
      metaCache.set(projIdent, meta);
      return meta;
    } catch {
      return undefined;
    }
  };

  const result: IntakeResult = { created: [], linked: [], skipped: [] };
  let dirty = false;
  for (const t of candidates) {
    if (result.created.length >= MAX_CREATE_PER_TICK) break;
    const guid = feishuGuidOf(t)!;
    const title = t.title ?? t.uid;
    try {
      // 已手工关联：只解析工单号落映射，不重复建单（项目由已有卡决定，无需归属解析）
      const linkHit = (t.description ?? "").match(PC_LINK_RE);
      if (linkHit) {
        const w = (await (await fetch(`${OPEN}/pjm/workitems/${linkHit[1]}`, { headers: PH })).json()) as { whole_identifier?: string };
        if (w.whole_identifier) {
          entries.push({ feishu_guid: guid, pingcode: w.whole_identifier, feishu_summary: title.slice(0, 40) });
          dirty = true;
          result.linked.push(`${w.whole_identifier}「${title.slice(0, 20)}」`);
        } else {
          noteSkip(guid, "手工链接解析不到工单号", title);
        }
        continue;
      }
      const attribution = resolveAttribution(t);
      const projIdent = pcProjectForAttribution(attribution);
      if (!projIdent) {
        const reason = attribution
          ? `归属 ${attribution} 不做 PingCode 同步`
          : "归属不明（无 [org/repo] 且台账无 projectRef）";
        noteSkip(guid, reason, title);
        result.skipped.push(title.slice(0, 24));
        continue;
      }
      // 建单（任务类型，描述带飞书链接与台账 uid）→ 回读确认 → 落映射
      const meta = await getMeta(projIdent);
      if (!meta) {
        noteSkip(guid, `PingCode 项目 ${projIdent} 不可达`, title);
        continue;
      }
      const cr = (await (await fetch(`${OPEN}/pjm/workitems`, {
        method: "POST",
        headers: PH,
        body: JSON.stringify({
          project_id: meta.projectId,
          title: title.slice(0, 120),
          type_id: meta.typeId,
          description: `飞书任务：https://www.feishu.cn/task/${guid}\n台账：${t.uid}\n（P 组入单自动创建）`,
        }),
      })).json()) as { id?: string; whole_identifier?: string };
      if (!cr.whole_identifier) {
        noteSkip(guid, "建单失败（无 whole_identifier）", title);
        continue;
      }
      entries.push({ feishu_guid: guid, pingcode: cr.whole_identifier, feishu_summary: title.slice(0, 40) });
      dirty = true;
      result.created.push(`${cr.whole_identifier}「${title.slice(0, 20)}」`);
    } catch (err) {
      console.error(`[pingcode-intake] 「${title.slice(0, 24)}」入单异常: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
  if (dirty) {
    try {
      writeFileSync(mapPath, JSON.stringify(entries, null, 1));
    } catch (e) {
      console.error(`[pingcode-intake] 映射表写失败: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
  if (Object.keys(sigs).some((k) => k.startsWith("skip:"))) {
    try {
      writeFileSync(statePath, JSON.stringify(sigs, null, 1));
    } catch { /* 状态文件写失败不影响主流程 */ }
  }
  return result;
}
