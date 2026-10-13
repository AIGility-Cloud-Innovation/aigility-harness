/** 验证：单任务 GET 是否返回 description（决定 gate 修复形状）+ 顺带重挪 3 个挂起任务（带输出） */
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
  // ① 单任务 GET
  for (const g of ["9551b47b-1986-409c-8712-16418ae86c76", "74a8d7a5-3f0c-4721-8f27-0d293eae40e2"]) {
    const d = await api("GET", `/open-apis/task/v2/tasks/${g}`, { user_id_type: "open_id" });
    const t = d?.data?.task;
    const desc = t?.description ?? "";
    console.log(`单GET ${g.slice(0, 8)}: code=${d.code} desc长度=${desc.length} 执行者agent=${/执行者[:：]\s*agent\b/i.test(desc) ? "✓" : "✗"} PR要求=${desc.includes("Gitea PR") ? "✓" : "✗"}`);
  }

  // ② 重挪 3 个挂起任务（P → ⏸），带完整响应
  const LIST = "d72fffc9-c62a-45f8-a9d4-34c45de2fbb8";
  const P = "c7d9b28e-2ed3-4146-b16e-fc6a7393db99";
  const PAUSE = "acf895f5-6f39-4643-a098-e755a2ecfebf";
  const r = await api("GET", `/open-apis/task/v2/sections/${P}/tasks`, { page_size: "100", user_id_type: "open_id" });
  for (const t of r?.data?.items ?? []) {
    const s = t.summary ?? "";
    if (!/(连续包月|备案|数据表格)/.test(s)) continue;
    const mv = await api("POST", `/open-apis/task/v2/tasks/${t.guid}/add_tasklist`, { user_id_type: "open_id" },
      { tasklist_guid: LIST, section_guid: PAUSE });
    console.log(`挪「${s.slice(0, 26)}」→ code=${mv.code} msg=${mv.msg ?? "ok"}`);
  }

  // ③ 复核两组
  for (const [name, guid] of [["P", P], ["⏸", PAUSE]] as const) {
    const rr = await api("GET", `/open-apis/task/v2/sections/${guid}/tasks`, { page_size: "100", user_id_type: "open_id" });
    console.log(`${name}组: ${(rr?.data?.items ?? []).length} 个`);
  }
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
