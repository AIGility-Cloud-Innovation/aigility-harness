/**
 * pingcode-status-sync — 飞书分组变化 → PingCode 卡状态联动（2026-10-23 用户拍板「2要做」）。
 *
 * 映射（任务类型实测流转集 TYY-129 探测：打开→进行中→已提测→关闭/已发布，
 * 「挂起/已完成/重新打开」置不了）：
 *   飞书 P 计划中  → PC 打开
 *   飞书 D 执行中  → PC 进行中
 *   飞书 C 待测试  → PC 已提测
 *   飞书完成(completed_at>0) → PC 关闭
 *   飞书挂起 → 不动（PC 无对应态）
 *
 * 机制（照 completion-sync 每拍前置模式）：
 *   · 数据源：config/feishu-pingcode-sync.map.json（guid↔工单号，①.558 入单对齐/手工关联时落；
 *     pr-finisher 交付建的「已修复」缺陷卡刻意不入表——缺陷卡自管生命周期，入表会被
 *     本联动按 C 待测试→「已提测」打，与「已修复」流转冲突）。
 *   · 防重：last-signature + 工单 id 缓存存 config/feishu-pingcode-sync.state.json，
 *     签名不变零 API 写；首拍逐卡检索一次工单 id 后复用。
 *   · 旁路：未配凭据/映射文件缺失/单条失败全部静默跳过，不阻塞对齐器。
 *
 * PingCode API 事实（2026-10-23 实测，详见 pingcode-api skill）：列表翻页已坏，
 * 找卡用 keywords 检索；PATCH {state_id} 后必须回读确认（200 可能静默忽略）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const OPEN = "https://open.pingcode.com/v2";

/** 飞书截面名 → PingCode 状态名（纯函数，单测覆盖）。 */
export function pcStateForSection(sectionName: string): string | undefined {
  if (sectionName.startsWith("P")) return "打开";
  if (sectionName.startsWith("D")) return "进行中";
  if (sectionName.startsWith("C")) return "已提测";
  return undefined; // 挂起/A 待修复/未知 → 不动
}

export interface PingcodeSyncDeps {
  /**
   * 台账快照（loop 侧构建，必须完整）：截面扫描给 completed=false 的卡，
   * 不在任何截面的映射卡补查 completed_at 后写入（completed=true → 关闭）。
   * 缺失的卡=数据不在手，跳过不猜。
   */
  snapshot: Map<string, { section: string; completed: boolean }>;
  repoRoot: string;
  notify?: (text: string) => void | Promise<void>;
}

interface MapEntry { feishu_guid: string; pingcode: string; feishu_summary?: string }

interface PcMeta {
  projectId: string;
  states: Map<string, string>; // 状态名 → state_id
}

/**
 * 每拍核对：映射表内每张卡比对期望态与上次签名，变了才 PATCH+回读。
 * 返回变更描述数组（空=无事发生）。
 */
export async function syncPingcodeStatuses(deps: PingcodeSyncDeps): Promise<string[]> {
  const { snapshot, repoRoot } = deps;
  const mapPath = process.env.PINGCODE_SYNC_MAP
    ? resolve(process.env.PINGCODE_SYNC_MAP)
    : resolve(repoRoot, "config/feishu-pingcode-sync.map.json");
  if (!existsSync(mapPath)) return [];
  const cid = process.env.PINGCODE_CLIENT_ID, csec = process.env.PINGCODE_CLIENT_SECRET;
  if (!cid || !csec) return [];
  let entries: MapEntry[];
  try {
    entries = JSON.parse(readFileSync(mapPath, "utf-8")) as MapEntry[];
  } catch {
    return [];
  }
  // token 现取（短时效，与存量脚本同姿势）
  const q = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec });
  let tok: string;
  try {
    tok = ((await (await fetch(`${OPEN}/auth/token?${q}`)).json()) as { access_token?: string }).access_token ?? "";
  } catch {
    return [];
  }
  if (!tok) return [];
  const PH = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const statePath = mapPath.replace(/\.json$/, ".state.json"); // 与映射表同目录，目录必然存在
  let sigs: Record<string, string> = {};
  try {
    sigs = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, string>;
  } catch { /* 首拍无状态文件 */ }

  const metaCache = new Map<string, PcMeta>(); // projIdent → meta（本次运行内）
  const getMeta = async (projIdent: string): Promise<PcMeta | undefined> => {
    const hit = metaCache.get(projIdent);
    if (hit) return hit;
    try {
      const projs = ((await (await fetch(`${OPEN}/pjm/projects`, { headers: PH })).json()) as { values?: Array<{ id: string; identifier: string }> }).values ?? [];
      const proj = projs.find((x) => x.identifier === projIdent);
      if (!proj) return undefined;
      const states = ((await (await fetch(`${OPEN}/pjm/workitem_states?project_id=${proj.id}&limit=100`, { headers: PH })).json()) as { values?: Array<{ id: string; name?: string }> }).values ?? [];
      const meta: PcMeta = { projectId: proj.id, states: new Map(states.map((s) => [s.name ?? "", s.id])) };
      metaCache.set(projIdent, meta);
      return meta;
    } catch {
      return undefined;
    }
  };

  const changes: string[] = [];
  for (const e of entries) {
    try {
      const snap = snapshot.get(e.feishu_guid);
      if (!snap) continue; // 快照无此卡：不猜（防截面扫描抖动误关；完成态由 loop 侧补查后写入快照）
      const want = snap.completed ? "关闭" : pcStateForSection(snap.section);
      if (!want) continue; // 挂起等：不联动
      const sig = want;
      if (sigs[e.feishu_guid] === sig) continue; // 签名不变零写
      const [projIdent] = e.pingcode.split("-");
      const meta = await getMeta(projIdent);
      if (!meta) continue;
      const stateId = meta.states.get(want);
      if (!stateId) continue;
      // 工单 id：缓存优先，缺失时 keywords 检索一次（列表翻页已坏）
      const sidKey = `${e.feishu_guid}:sid`;
      const cached = sigs[sidKey];
      let workitemId: string;
      if (cached) {
        workitemId = cached;
      } else {
        const hit = (await (await fetch(`${OPEN}/pjm/workitems?project_id=${meta.projectId}&keywords=${encodeURIComponent(e.pingcode)}`, { headers: PH })).json()) as { values?: Array<{ id: string; whole_identifier?: string }> };
        const found = (hit.values ?? []).find((w) => w.whole_identifier === e.pingcode)?.id;
        if (!found) continue;
        workitemId = found;
        sigs[sidKey] = workitemId;
      }
      // 现态核对：已是期望态只记账不写
      const cur = (await (await fetch(`${OPEN}/pjm/workitems/${workitemId}`, { headers: PH })).json()) as { state?: { name?: string } };
      if (cur.state?.name === want) {
        sigs[e.feishu_guid] = sig;
        continue;
      }
      // PATCH + 回读确认（200 可能静默忽略）
      await fetch(`${OPEN}/pjm/workitems/${workitemId}`, { method: "PATCH", headers: PH, body: JSON.stringify({ state_id: stateId }) });
      const after = ((await (await fetch(`${OPEN}/pjm/workitems/${workitemId}`, { headers: PH })).json()) as { state?: { name?: string } }).state?.name;
      if (after === want) {
        sigs[e.feishu_guid] = sig;
        changes.push(`${e.pingcode} → ${want}`);
      } else {
        console.error(`[pingcode-sync] ${e.pingcode} 置 ${want} 失败（停在 ${after ?? "?"}），下拍重试`);
      }
    } catch (err) {
      console.error(`[pingcode-sync] ${e.pingcode} 同步异常: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
  try {
    writeFileSync(statePath, JSON.stringify(sigs, null, 1));
  } catch { /* 状态文件写失败不影响主流程 */ }
  if (changes.length > 0) {
    const text = `📌 PingCode 状态联动：${changes.join("、")}`;
    try {
      await deps.notify?.(text);
    } catch { /* 通知失败不阻塞 */ }
  }
  return changes;
}
