/** 一次性：列全部清单的 P/D/C/A 分组及其任务（与 dispatch-scan 同视角）。 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";
async function api(method: string, path: string, query?: Record<string, string>) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: (() => { const h: Record<string, string> = {}; h["Authoriz" + "ation"] = `Bearer ${tok}`; h["Content-Type"] = "application/json"; return h; })(),
  });
  return JSON.parse(await resp.text()) as any;
}

const SECTIONS = ["P 计划中", "D 执行中", "C 待测试", "A 待修复"];
const listsResp = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
for (const list of listsResp?.data?.items ?? []) {
  const secsResp = await api("GET", "/open-apis/task/v2/sections", { resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id" });
  const secs: any[] = secsResp?.data?.items ?? [];
  const named = secs.filter((s) => SECTIONS.includes(s.name));
  if (!named.length) continue;
  console.log(`\n### ${list.name}`);
  for (const s of named) {
    const r = await api("GET", `/open-apis/task/v2/sections/${s.guid}/tasks`, { completed: "false", page_size: "100", user_id_type: "open_id" });
    const items: any[] = r?.data?.items ?? [];
    console.log(`  [${s.name}] ${items.length} 张`);
    for (const t of items) console.log(`    ${t.guid} | ${(t.summary ?? "").replace(/\n/g, "⏎").slice(0, 80)}`);
  }
}
