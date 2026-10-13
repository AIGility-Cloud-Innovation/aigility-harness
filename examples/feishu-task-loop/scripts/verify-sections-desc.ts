/** 核查：P/⏸ 分组实况 + 我两任务的 description 是否真持久化 + 列表端点是否带 description */
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
  const P = "c7d9b28e-2ed3-4146-b16e-fc6a7393db99";
  const PAUSE = "acf895f5-6f39-4643-a098-e755a2ecfebf";

  for (const [name, guid] of [["P 计划中", P], ["⏸ 挂起", PAUSE]] as const) {
    const r = await api("GET", `/open-apis/task/v2/sections/${guid}/tasks`, { page_size: "100", user_id_type: "open_id" });
    const items = r?.data?.items ?? [];
    const withDesc = items.filter((t: any) => (t.description ?? "").length > 0).length;
    console.log(`${name}: ${items.length} 个（其中 description 非空 ${withDesc} 个）`);
    const mine = items.filter((t: any) => (t.summary ?? "").includes("记忆权益") || (t.summary ?? "").includes("新账号开通即赠"));
    for (const t of mine) console.log(`  ★ ${(t.summary ?? "").slice(0, 40)} | desc长度=${(t.description ?? "").length} | 含执行者agent=${/执行者[:：]\s*agent\b/i.test(t.description ?? "")}`);
    const paused = items.filter((t: any) => (t.summary ?? "").includes("挂起") || (t.summary ?? "").includes("连续包月") || (t.summary ?? "").includes("备案") || (t.summary ?? "").includes("数据表格"));
    for (const t of paused) console.log(`  ⏸ ${(t.summary ?? "").slice(0, 40)}`);
  }
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
