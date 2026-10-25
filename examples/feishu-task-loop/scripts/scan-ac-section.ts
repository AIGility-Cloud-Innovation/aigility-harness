/** 分页拉全量任务，统计各分组分布 */
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

const LIST_NAME = "AIGility-Cloud-Innovation";
const lists = (await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" })).data?.items ?? [];
const list = lists.find((x: any) => x.name === LIST_NAME);
if (!list) throw new Error("清单不存在");

const secs = (await api("GET", "/open-apis/task/v2/sections", {
  resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id",
})).data?.items ?? [];
const secByGuid = new Map<string, string>(secs.map((s: any) => [s.guid, s.name]));

// 分页拉全量
let pageToken: string | undefined;
const all: any[] = [];
let page = 0;
while (true) {
  page++;
  const q: Record<string, string> = {
    page_size: "100",
    resource_type: "tasklist",
    resource_id: list.guid,
    user_id_type: "open_id",
  };
  if (pageToken) q.page_token = pageToken;
  const r = await api("GET", "/open-apis/task/v2/tasks", q);
  if ((r?.code ?? -1) !== 0) { console.log(`分页错误: ${r?.code} ${r?.msg}`); break; }
  const items = r?.data?.items ?? [];
  all.push(...items);
  console.log(`第 ${page} 页: ${items.length} 条, has_more=${r?.data?.has_more}`);
  if (!r?.data?.has_more) break;
  pageToken = r.data.page_token;
  if (page > 30) break;
}
console.log(`\n总计: ${all.length} 条（清单内）`);

// 按分组统计（membership 需要逐个查，抽样看前 30 条 + 关键字匹配）
const counts = new Map<string, number>();
for (const t of all) {
  const secName = secByGuid.get(t.section_guid ?? "") ?? "(未分组)";
  counts.set(secName, (counts.get(secName) ?? 0) + 1);
}
console.log("\n=== 分组分布 ===");
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

// 找带 agent 标记的任务
console.log("\n=== 含「执行者：agent」的任务 ===");
for (const t of all) {
  const desc = String(t.description ?? "");
  if (/执行者[：:]\s*agent/i.test(desc)) {
    const secName = secByGuid.get(t.section_guid ?? "") ?? "(未分组)";
    console.log(`  [${secName}] ${String(t.summary).slice(0, 56)}`);
    console.log(`      guid=${t.guid}`);
  }
}
