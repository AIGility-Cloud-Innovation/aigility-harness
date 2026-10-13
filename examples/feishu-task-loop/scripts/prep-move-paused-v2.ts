/** 挪挂起任务 v2：用正确的 sections 子路径端点列 P 组，模糊匹配挪「⏸ 挂起」；顺带验证两任务描述 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";
const LIST_GUID = "d72fffc9-c62a-45f8-a9d4-34c45de2fbb8";
const P_GUID = "c7d9b28e-2ed3-4146-b16e-fc6a7393db99";
const PAUSE_GUID = "acf895f5-6f39-4643-a098-e755a2ecfebf";

async function api(method: string, path: string, query?: Record<string, string>, body?: unknown) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await resp.json()) as any;
}

const PAUSE_KEYS = ["连续包月", "备案", "数据表格"];

try {
  // ① 正确端点列 P 组
  const pts = await api("GET", `/open-apis/task/v2/sections/${P_GUID}/tasks`, {
    page_size: "100", user_id_type: "open_id",
  });
  const items = (pts?.data?.items ?? []).filter((t: any) => !t.completed_at || Number(t.completed_at) === 0);
  console.log("P 组未完成任务数:", items.length);
  let moved = 0;
  for (const t of items) {
    const summary = t.summary ?? "";
    const hit = PAUSE_KEYS.some((k) => summary.includes(k));
    if (!hit) continue;
    const mv = await api("POST", `/open-apis/task/v2/tasks/${t.guid}/add_tasklist`, { user_id_type: "open_id" },
      { tasklist_guid: LIST_GUID, section_guid: PAUSE_GUID });
    console.log(`  挪「${summary.slice(0, 36)}」→ ⏸: code=${mv?.code}`);
    if ((mv?.code ?? -1) === 0) moved++;
  }
  console.log(`共挪 ${moved} 个挂起任务`);

  // ② 验证两任务描述关键标记
  for (const g of ["9551b47b-1986-409c-8712-16418ae86c76", "74a8d7a5-3f0c-4721-8f27-0d293eae40e2"]) {
    const d = await api("GET", `/open-apis/task/v2/tasks/${g}`, { user_id_type: "open_id" });
    const desc = d?.data?.task?.description ?? "";
    console.log(`${g.slice(0, 8)}: 执行者:agent=${/执行者[:：]\s*agent\b/i.test(desc) ? "✓" : "✗"} | PR要求=${desc.includes("Gitea PR") ? "✓" : "✗"} | 残留agentd=${desc.includes("agentd") ? "有!" : "无"}`);
  }
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
