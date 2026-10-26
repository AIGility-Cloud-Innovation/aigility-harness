/** 回查 6 张卡的清单归属与分组 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";
async function api(method: string, path: string, query?: Record<string, string>) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
  });
  return (await resp.json()) as any;
}

const GUIDS = [
  "db025d48-3629-4895-9006-ead9c40ed834",
  "b54dc668-7c9b-4d34-94b6-bfe96accd4c6",
  "68e48f61-3f51-48f0-916a-a8d1f52ebef4",
  "93106120-8b2d-44b6-ad35-d4f09dc271e2",
  "5472f852-234c-44bc-a2a3-46986d6923de",
  "b6b83dbf-6b62-4e28-94f9-f563b0c03196",
];

const lists = (await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" })).data?.items ?? [];
const listName = new Map<string, string>(lists.map((l: any) => [l.guid, l.name]));
const secName = new Map<string, string>();
for (const l of lists) {
  const secs = (await api("GET", "/open-apis/task/v2/sections", {
    resource_type: "tasklist", resource_id: l.guid, page_size: "50", user_id_type: "open_id",
  })).data?.items ?? [];
  for (const s of secs) secName.set(s.guid, s.name);
}

for (const g of GUIDS) {
  const r = await api("GET", `/open-apis/task/v2/tasks/${g}`, { user_id_type: "open_id" });
  const t = r?.data?.task;
  if (!t) { console.log(`❌ ${g} 读取失败 ${r?.code} ${r?.msg}`); continue; }
  const memberships = t.tasklists ?? [];
  for (const m of memberships) {
    console.log(`「${(t.summary ?? "").slice(0, 44)}…」`);
    console.log(`   清单=${listName.get(m.tasklist_guid) ?? m.tasklist_guid}  分组=${secName.get(m.section_guid) ?? m.section_guid}`);
  }
  if (!memberships.length) console.log(`⚠️ ${g} 未挂任何清单`);
}
