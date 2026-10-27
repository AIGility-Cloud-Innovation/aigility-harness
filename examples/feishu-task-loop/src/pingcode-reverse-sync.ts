/**
 * pingcode-reverse-sync — PingCode 关闭/发布 → 飞书任务自动完成 + 台账关单
 * （2026-10-23 用户拍板「反向的pc到飞书关闭任务是要做的」）。
 *
 * 交付事实校验：PR 合并是完成联动的闸门。映射卡 PC 终态先查台账 note 的
 * PR 链接与 Gitea merged 状态；有已合并 PR 才完成联动。台账没 PR 时去 PC 卡
 * 描述取证（2026-10-27 拍板：真人交付常把 PR 只贴在 PC 描述里；评论接口本实例
 * 404 不可用）——描述里有已合并 PR 同样放行，并把链接回写台账 note 与飞书任务
 * 描述（幂等）。两处都没有才问询一次，显式回复「确认关单 <PC编号>」后补关：
 *   · 台账非 done：合法路径转 done（直达或经 review 两跳，与 completion-sync 同姿势）
 *   · 飞书任务 PATCH completed_at 标完成（review-aware.ts:764 同形态）
 *   · 台账找不到/已 done：跳过（找不到=游离卡，不猜；已 done=闭环完成）
 *
 * 确认双通道（2026-10-27 缺陷修复）：receivedMessages 只随对齐拍（默认 30min）
 * 消费，且飞书消息常带零宽字符让 ^$ 锚失配——confirm 会迟到甚至永远不中。故
 *   ① 匹配前剥零宽字符（sanitizeCommandText）；
 *   ② 指令链路（review-aware）收到「确认关单」即时调 recordClosureConfirmation
 *     落 state 文件（`${guid}:pc-confirm`），对齐拍直接消费，不等消息缓冲。
 *
 * 与正向联动（pingcode-status-sync.ts）不打架：
 *   正向只在飞书变化时写 PC；PC「关闭」后正向快照 completed=true → 期望态=关闭
 *   → 现态已是关闭 → 只记账不写。反向只在 PC 侧变化时写飞书。
 *
 * 工单 id 缓存复用正向的 map.state.json（`${guid}:sid`），零额外检索。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OPEN = "https://open.pingcode.com/v2";
const CLOSED_STATES = new Set(["关闭", "已发布"]);

/** 台账/注册表最小接口（结构化类型，便于单测注入假件）。 */
export interface ReverseSyncRegistry {
  list(filter?: { status?: string[] }): Array<{
    uid: string;
    status?: string;
    note?: string;
    links?: Record<string, { guid?: string }>;
    origin?: { provider: string; guid?: string };
  }>;
  transition(uid: string, to: string, from?: string): { ok: boolean };
  /** 台账字段更新（可选；有则 PC 描述取证的 PR 会回写 note 留证） */
  update?(uid: string, patch: { note?: string }): unknown;
}

type Call = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { code?: number; msg?: string; data?: unknown };
  error?: string;
}>;

type GiteaCall = (req: Record<string, unknown>) => Promise<{
  ok: boolean;
  value?: { status?: number; data?: unknown };
  error?: string;
}>;

type NotificationSink = (text: string) => Promise<void> | void;

export const PR_URL_PATTERN = /https:\/\/git\.aigility\.cloud\/[^\s（)）]+\/pulls\/\d+/;
export const CONFIRM_COMMAND_PATTERN = /^确认关单\s*[:：]?\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*$/u;
const PENDING_SIGNATURE = "pc-closed-no-pr";
const CONFIRM_MARK_SUFFIX = ":pc-confirm";

/** 剥飞书消息里的零宽/不可见字符再匹配（\s 不含 U+200B–200F/U+2060，尾随即失配）。 */
export function sanitizeCommandText(raw: string): string {
  return String(raw).replace(/[\u200b-\u200f\u2060\ufeff]/g, "").trim();
}

function giteaPrRequest(prUrl: string): Record<string, unknown> | undefined {
  const m = prUrl.match(/\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  if (!m) return undefined;
  return { method: "GET", path: `/api/v1/repos/${m[1]}/${m[2]}/pulls/${m[3]}` };
}

function isMergedPr(value: { status?: number; data?: unknown } | undefined): boolean {
  const pr = value?.data as { merged?: unknown } | undefined;
  return value?.status === 200 && pr?.merged === true;
}

/** 台账 note 中的 PR 链接必须真实 merged；无链接/API 失败均不视为交付事实。 */
export async function hasMergedDeliveryPr(record: { note?: string }, giteaCall: GiteaCall): Promise<boolean> {
  const prUrl = record.note?.match(PR_URL_PATTERN)?.[0];
  const req = prUrl ? giteaPrRequest(prUrl) : undefined;
  if (!req) return false;
  try {
    const r = await giteaCall(req);
    return r.ok && isMergedPr(r.value);
  } catch {
    return false;
  }
}

interface MapEntry { feishu_guid: string; pingcode: string; feishu_summary?: string }

/** 飞书标完成（与 review-aware completeTask 同形态）。 */
export async function completeFeishuTask(call: Call, taskGuid: string): Promise<boolean> {
  try {
    const r = await call({
      method: "PATCH",
      path: `/open-apis/task/v2/tasks/${taskGuid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { update_fields: ["completed_at"], task: { completed_at: String(Date.now()) } },
    });
    return r.ok && (r.value?.code === undefined || r.value.code === 0);
  } catch {
    return false;
  }
}

/** 飞书任务描述尾部追加 PR 链接（幂等：描述已含同链接则跳过；issue-link-backfill 同形态）。 */
export async function appendPrToFeishuDescription(
  call: Call,
  taskGuid: string,
  prUrls: string[],
): Promise<boolean> {
  try {
    const cur = await call({
      method: "GET",
      path: `/open-apis/task/v2/tasks/${taskGuid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
    });
    const desc = (cur.value?.data as { task?: { description?: string } } | undefined)?.task?.description ?? "";
    const fresh = prUrls.filter((u) => !desc.includes(u));
    if (fresh.length === 0) return true;
    const next = desc ? `${desc}\n交付 PR：${fresh.join(" ")}` : `交付 PR：${fresh.join(" ")}`;
    const r = await call({
      method: "PATCH",
      path: `/open-apis/task/v2/tasks/${taskGuid}`,
      query: { user_id_type: "open_id" },
      identity: "user",
      body: { update_fields: ["description"], task: { description: next } },
    });
    return r.ok && (r.value?.code === undefined || r.value.code === 0);
  } catch {
    return false;
  }
}

/** 即时确认（review-aware 指令链路调用）：state 文件落 `${guid}:pc-confirm`，对齐拍直接消费。 */
export function recordClosureConfirmation(
  repoRoot: string,
  pingcodeId: string,
): { ok: boolean; error?: string } {
  const mapPath = process.env.PINGCODE_SYNC_MAP
    ? resolve(process.env.PINGCODE_SYNC_MAP)
    : resolve(repoRoot, "config/feishu-pingcode-sync.map.json");
  let entries: MapEntry[];
  try {
    entries = JSON.parse(readFileSync(mapPath, "utf-8")) as MapEntry[];
  } catch {
    return { ok: false, error: "同步映射表不可读" };
  }
  const hit = entries.find((e) => e.pingcode === pingcodeId.toUpperCase());
  if (!hit) return { ok: false, error: "映射表里没有这张卡" };
  const statePath = mapPath.replace(/\.json$/, ".state.json");
  let sigs: Record<string, string> = {};
  try {
    sigs = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
  } catch { /* 首拍无状态文件 */ }
  sigs[`${hit.feishu_guid}${CONFIRM_MARK_SUFFIX}`] = "confirmed";
  try {
    writeFileSync(statePath, JSON.stringify(sigs, null, 1));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** PC 卡描述全文（失败返空串——取证是增益路径，不阻塞闸门）。 */
async function pcDescription(workitemId: string, PH: Record<string, string>): Promise<string> {
  try {
    const r = (await (await fetch(`${OPEN}/pjm/workitems/${workitemId}`, { headers: PH })).json()) as { description?: string };
    return r.description ?? "";
  } catch {
    return "";
  }
}

/**
 * 每拍反向核对：PC 终态卡 → 飞书完成 + 台账 done。返回变更描述。
 * @param feishuCall 飞书 API 调用器（loop 侧注入 alignFeishuCall 同款）
 */
export async function syncPingcodeClosures(
  registry: ReverseSyncRegistry,
  repoRoot: string,
  feishuCall: Call,
  options: { giteaCall?: GiteaCall; notify?: NotificationSink; receivedMessages?: readonly string[] } = {},
): Promise<string[]> {
  const mapPath = process.env.PINGCODE_SYNC_MAP
    ? resolve(process.env.PINGCODE_SYNC_MAP)
    : resolve(repoRoot, "config/feishu-pingcode-sync.map.json");
  const cid = process.env.PINGCODE_CLIENT_ID, csec = process.env.PINGCODE_CLIENT_SECRET;
  if (!cid || !csec) return [];
  let entries: MapEntry[];
  try {
    entries = JSON.parse(readFileSync(mapPath, "utf-8")) as MapEntry[];
  } catch {
    return [];
  }
  // 待核对卡快速预筛：台账非 done 的才需要看 PC（done 的已闭环）
  const pending = entries.filter((e) => {
    const rec = registry
      .list()
      .find((t) => t.links?.["feishu-task"]?.guid === e.feishu_guid || (t.origin?.provider === "feishu-task" && t.origin?.guid === e.feishu_guid));
    return !!rec && rec.status !== "done";
  });
  if (pending.length === 0) return [];
  // token 现取
  const q = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec });
  let tok: string;
  try {
    tok = ((await (await fetch(`${OPEN}/auth/token?${q}`)).json()) as { access_token?: string }).access_token ?? "";
  } catch {
    return [];
  }
  if (!tok) return [];
  const PH = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const statePath = mapPath.replace(/\.json$/, ".state.json");
  let sigs: Record<string, string> = {};
  try {
    sigs = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
  } catch { /* 首拍无状态文件 */ }

  const confirmed = new Set<string>();
  for (const raw of options.receivedMessages ?? []) {
    const m = sanitizeCommandText(raw).match(CONFIRM_COMMAND_PATTERN);
    const hit = m ? entries.find((e) => e.pingcode === m[1]) : undefined;
    if (m && hit) confirmed.add(hit.feishu_guid);
  }
  // 即时确认通道（review-aware 指令落 state 文件）：不等消息缓冲随对齐拍来
  for (const [k, v] of Object.entries(sigs)) {
    if (v === "confirmed" && k.endsWith(CONFIRM_MARK_SUFFIX)) confirmed.add(k.slice(0, -CONFIRM_MARK_SUFFIX.length));
  }

  const metaCache = new Map<string, { projectId: string; ok: boolean }>();
  const changes: string[] = [];
  try {
    const projs = ((await (await fetch(`${OPEN}/pjm/projects`, { headers: PH })).json()) as { values?: Array<{ id: string; identifier: string }> }).values ?? [];
    for (const p of projs) metaCache.set(p.identifier, { projectId: p.id, ok: true });
  } catch { return []; }

  for (const e of pending) {
    try {
      const [projIdent] = e.pingcode.split("-");
      const meta = metaCache.get(projIdent);
      if (!meta) continue;
      const sidKey = `${e.feishu_guid}:sid`;
      const cachedId = sigs[sidKey];
      let workitemId: string;
      if (cachedId) {
        workitemId = cachedId;
      } else {
        const hit = (await (await fetch(`${OPEN}/pjm/workitems?project_id=${meta.projectId}&keywords=${encodeURIComponent(e.pingcode)}`, { headers: PH })).json()) as { values?: Array<{ id: string; whole_identifier?: string }> };
        const found = (hit.values ?? []).find((w) => w.whole_identifier === e.pingcode)?.id;
        if (!found) continue;
        workitemId = found;
        sigs[sidKey] = workitemId;
      }
      const cur = ((await (await fetch(`${OPEN}/pjm/workitems/${workitemId}`, { headers: PH })).json()) as { state?: { name?: string } }).state?.name;
      if (!cur || !CLOSED_STATES.has(cur)) continue; // 非终态：正向联动管
      const closedNow = cur;
      // 台账转 done（合法路径：直达或经 review 两跳）
      const rec = registry
        .list()
        .find((t) => t.links?.["feishu-task"]?.guid === e.feishu_guid || (t.origin?.provider === "feishu-task" && t.origin?.guid === e.feishu_guid));
      if (!rec) continue; // 双检（预筛后状态可能已变）
      // 交付事实三层：① 台账 note 的 PR → ② PC 卡描述取证的 PR（真人交付常只贴 PC 描述）→ ③ 人工确认
      let merged = options.giteaCall ? await hasMergedDeliveryPr(rec, options.giteaCall) : false;
      let evidencePrs: string[] = [];
      if (!merged) {
        const desc = await pcDescription(workitemId, PH);
        evidencePrs = [...new Set(desc.match(new RegExp(PR_URL_PATTERN.source, "g")) ?? [])];
        for (const url of evidencePrs) {
          const req = giteaPrRequest(url);
          if (!req || !options.giteaCall) break;
          try {
            if (isMergedPr((await options.giteaCall(req)).value)) {
              merged = true;
              break;
            }
          } catch { /* 单条取证失败继续下一条 */ }
        }
      }
      if (!merged && !confirmed.has(e.feishu_guid)) {
        const askKey = `${e.feishu_guid}:${PENDING_SIGNATURE}`;
        if (sigs[askKey] !== PENDING_SIGNATURE) {
          const hint = evidencePrs.length > 0 ? "（描述里有 PR 但均未合并）" : "";
          const text = `PC 卡 ${e.pingcode} 被关闭但无交付记录${hint}，若为归并作废请回复「确认关单 ${e.pingcode}」。`;
          try {
            await options.notify?.(text);
            sigs[askKey] = PENDING_SIGNATURE;
            writeFileSync(statePath, JSON.stringify(sigs, null, 1));
            changes.push(`${e.pingcode} 已关闭但无交付PR → 已问询`);
          } catch {
            changes.push(`${e.pingcode} 已关闭但无交付PR → 问询失败，下拍重试`);
          }
        }
        continue;
      }
      const okDone =
        registry.transition(rec.uid, "done").ok ||
        (registry.transition(rec.uid, "review").ok && registry.transition(rec.uid, "done", "review").ok);
      if (!okDone) continue;
      // 飞书标完成
      const done = await completeFeishuTask(feishuCall, e.feishu_guid);
      const via = evidencePrs.length > 0 ? "（PR 取证自 PC 描述）" : "";
      changes.push(`${e.pingcode} PC已${closedNow} → 台账done${via}${done ? "+飞书已完成" : "（飞书标完成失败,下拍重试）"}`);
      // PR 链接回写（2026-10-27 拍板）：台账 note 留证据 + 飞书描述同步——失败均不阻塞已落地的关单
      if (evidencePrs.length > 0) {
        try {
          if (rec.note && !evidencePrs.every((u) => rec.note?.includes(u))) {
            registry.update?.(rec.uid, { note: `${rec.note}\n交付 PR（取证自 PC 描述）：${evidencePrs.join(" ")}` });
          }
        } catch { /* note 回写失败不影响 */ }
        const linked = await appendPrToFeishuDescription(feishuCall, e.feishu_guid, evidencePrs);
        if (!linked) console.warn(`[pingcode-reverse] ${e.pingcode} PR 回写飞书描述失败（关单已落地，链接留在 PC 描述）`);
      }
      delete sigs[`${e.feishu_guid}${CONFIRM_MARK_SUFFIX}`]; // 确认已消费
      try {
        writeFileSync(statePath, JSON.stringify(sigs, null, 1));
      } catch { /* 状态写失败不影响 */ }
    } catch (err) {
      console.error(`[pingcode-reverse] ${e.pingcode} 反向核对异常: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
  return changes;
}
