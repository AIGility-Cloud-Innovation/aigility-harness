/** 干跑：只读验证 user token 链路与清单/分组存在性（不建任何任务） */
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

try {
  const lists = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
  console.log("code:", lists.code, "清单数:", lists?.data?.items?.length ?? 0);
  for (const it of lists?.data?.items ?? []) {
    console.log(`  ${it.name}  guid=${it.guid}`);
    const secs = await api("GET", "/open-apis/task/v2/sections", {
      resource_type: "tasklist", resource_id: it.guid, page_size: "50", user_id_type: "open_id",
    });
    if ((secs?.code ?? -1) !== 0) {
      console.log(`    └─ 分组查询失败 code=${secs?.code} ${secs?.msg}`);
      continue;
    }
    for (const s of secs?.data?.items ?? []) console.log(`    ├─ ${s.name} (${s.guid})`);
  }
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
