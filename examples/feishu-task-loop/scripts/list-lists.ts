/** 列出全部清单 + 分组 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";

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

const listsResp = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
const lists = listsResp?.data?.items ?? [];
console.log(`清单数: ${lists.length}`);
for (const l of lists) {
  const secsResp = await api("GET", "/open-apis/task/v2/sections", {
    resource_type: "tasklist",
    resource_id: l.guid,
    page_size: "50",
    user_id_type: "open_id",
  });
  const secs = secsResp?.data?.items ?? [];
  console.log(`\n清单: 「${l.name}」  guid=${l.guid}`);
  for (const s of secs) console.log(`   分组: 「${s.name}」 guid=${s.guid}`);
}
