/**
 * pingcode-reverse-sync — PingCode 关闭/发布 → 飞书任务自动完成 + 台账关单
 * （2026-10-23 用户拍板「反向的pc到飞书关闭任务是要做的」）。
 *
 * 交付事实校验：PR 合并是完成联动的闸门。映射卡 PC 终态先查台账 note 的
 * PR 链接与 Gitea merged 状态；有已合并 PR 才完成联动。无 PR 时只问询一次，
 * 显式回复「确认关单 <PC编号>」后，下一拍才按人工确认补关。
 *   · 台账非 done：合法路径转 done（直达或经 review 两跳，与 completion-sync 同姿势）
 *   · 飞书任务 PATCH completed_at 标完成（review-aware.ts:764 同形态）
 *   · 台账找不到/已 done：跳过（找不到=游离卡，不猜；已 done=闭环完成）
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
    const m = String(raw).trim().match(CONFIRM_COMMAND_PATTERN);
    const hit = m ? entries.find((e) => e.pingcode === m[1]) : undefined;
    if (m && hit) confirmed.add(hit.feishu_guid);
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
      const merged = options.giteaCall ? await hasMergedDeliveryPr(rec, options.giteaCall) : false;
      if (!merged && !confirmed.has(e.feishu_guid)) {
        const askKey = `${e.feishu_guid}:${PENDING_SIGNATURE}`;
        if (sigs[askKey] !== PENDING_SIGNATURE) {
          const text = `PC 卡 ${e.pingcode} 被关闭但无交付记录，若为归并作废请回复「确认关单 ${e.pingcode}」。`;
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
      changes.push(`${e.pingcode} PC已${closedNow} → 台账done${done ? "+飞书已完成" : "（飞书标完成失败,下拍重试）"}`);
      try {
        writeFileSync(statePath, JSON.stringify(sigs, null, 1));
      } catch { /* 状态写失败不影响 */ }
    } catch (err) {
      console.error(`[pingcode-reverse] ${e.pingcode} 反向核对异常: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
  return changes;
}
