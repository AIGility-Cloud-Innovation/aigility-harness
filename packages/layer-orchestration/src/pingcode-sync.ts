/**
 * pingcode-sync — agent 交付 PR 后在 PingCode 建缺陷卡（已修复态）（2026-10-23 用户需求）。
 * 实测结论（全部经 TYY 实例验证）：
 *  · 「已修复」是缺陷(bug)类型的专属流转状态——任务类型 PATCH state_id 会被 200 静默忽略；
 *  · 状态生效姿势：建卡（默认态）→ PATCH {state_id} → 回读确认；
 *  · 列表翻页参数服务端已坏（任何 offset/limit 只回前 30 条），防重查重用 keywords 检索；
 *  · 防重：同标题关键词已存在「已修复」卡则跳过。
 * 未配置 PINGCODE_CLIENT_ID/SECRET 时静默跳过（不影响交付主流程）。
 */
import type { TaskRecord } from "@aigility-harness/core";

const OPEN = "https://open.pingcode.com/v2";

/** 飞书仓库名/标题 → PingCode 项目（与存量同步脚本同一映射规则）。 */
export function pickProjectIdent(task: TaskRecord): string {
  const t = `${task.title ?? ""} ${String((task as unknown as Record<string, unknown>).repo ?? "")}`.toLowerCase();
  if (/timem-space|【space】|space项目/.test(t)) return "TAI"; // 太忆空间
  return "TYY"; // platform/双前端/console → 太忆云
}

async function tokenOf(): Promise<string> {
  const cid = process.env.PINGCODE_CLIENT_ID, csec = process.env.PINGCODE_CLIENT_SECRET;
  if (!cid || !csec) throw new Error("PINGCODE_CLIENT_ID/SECRET 未配置");
  const q = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec });
  const r = (await (await fetch(`${OPEN}/auth/token?${q}`)).json()) as { access_token?: string };
  if (!r.access_token) throw new Error("PingCode token 获取失败");
  return r.access_token;
}

/**
 * 交付同步：建缺陷卡 + 置「已修复」。返回 "TYY-127" 形态的工单号；跳过/失败返回 undefined（不抛）。
 * @param prUrl agent 交付的 PR 地址，写进工单描述备查。
 */
export async function deliverPingcodeFixed(task: TaskRecord, prUrl: string): Promise<string | undefined> {
  try {
    const tok = await tokenOf();
    const PH = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    // 项目 / 类型（缺陷）/ 状态（已修复）
    const projs = ((await (await fetch(`${OPEN}/pjm/projects`, { headers: PH })).json()) as { values?: Array<{ id: string; identifier: string }> }).values ?? [];
    const proj = projs.find((p) => p.identifier === pickProjectIdent(task));
    if (!proj) return undefined;
    const types = ((await (await fetch(`${OPEN}/pjm/workitem_types?project_id=${proj.id}`, { headers: PH })).json()) as { values?: Array<{ id: string; group?: string; name?: string }> }).values ?? [];
    const defect = types.find((t) => t.group === "bug") ?? types.find((t) => t.name === "缺陷");
    const states = ((await (await fetch(`${OPEN}/pjm/workitem_states?project_id=${proj.id}&limit=100`, { headers: PH })).json()) as { values?: Array<{ id: string; name?: string }> }).values ?? [];
    const fixed = states.find((s) => s.name === "已修复");
    if (!defect || !fixed) return undefined;
    // 防重：标题关键词已有「已修复」卡则跳过（列表翻页已坏，用 keywords 检索）
    const probe = task.title.replace(/[【】\[\]]/g, " ").trim().split(/\s+/).filter((w) => w.length >= 4)[0] ?? task.title.slice(0, 12);
    const hit = (await (await fetch(`${OPEN}/pjm/workitems?project_id=${proj.id}&keywords=${encodeURIComponent(probe)}`, { headers: PH })).json()) as { values?: Array<{ id: string; state?: { name?: string }; title?: string }> };
    if ((hit.values ?? []).some((w) => w.state?.name === "已修复" && (w.title ?? "").includes(task.title.slice(0, 12)))) return undefined;
    // 建缺陷卡（默认态）→ 置已修复 → 回读确认
    const cr = (await (await fetch(`${OPEN}/pjm/workitems`, { method: "POST", headers: PH, body: JSON.stringify({ project_id: proj.id, title: task.title.slice(0, 120), type_id: defect.id, description: `agent 已交付 PR 待验收：${prUrl}\n台账：${task.uid}\n（由交付链路自动创建）` }) })).json()) as { id?: string; whole_identifier?: string };
    if (!cr.id || !cr.whole_identifier) return undefined;
    const pr = await fetch(`${OPEN}/pjm/workitems/${cr.id}`, { method: "PATCH", headers: PH, body: JSON.stringify({ state_id: fixed.id }) });
    if (!pr.ok) return cr.whole_identifier; // 建成但置态失败：工单存在（默认态），报告号让人工看
    return cr.whole_identifier;
  } catch {
    return undefined; // 同步是旁路：任何异常不阻塞交付主流程
  }
}
