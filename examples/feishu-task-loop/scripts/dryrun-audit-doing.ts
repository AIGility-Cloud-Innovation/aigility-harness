/** 干跑2：只读盘点 TiMEM-AI 清单 D 组存量任务（开 scan 前的误派发风险评估） */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";
const LIST_GUID = "d72fffc9-c62a-45f8-a9d4-34c45de2fbb8"; // TiMEM-AI
const D_GUID = "1684de5e-44e2-45a2-b950-cdfd81adf728"; // D 执行中

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
  const r = await api("GET", `/open-apis/task/v2/tasks`, {
    tasklist_guid: LIST_GUID, section_guid: D_GUID, page_size: "50", user_id_type: "open_id",
  });
  console.log("code:", r.code, "D 组任务数:", r?.data?.items?.length ?? 0);
  for (const t of r?.data?.items ?? []) {
    const summary = t.summary ?? "";
    const hasIssue = /\[[^\]#]+\/[^\]#]+#\d+\]/.test(summary);
    const desc = t.description ?? "";
    const exec = desc.match(/执行者[:：]\s*(\S+)/)?.[1] ?? "(无标记)";
    const hasAssignee = (t.members ?? []).some((m: any) => m.role === "assignee");
    console.log(`  [${t.guid?.slice(0, 8)}] ${summary.slice(0, 44)} | 工单号:${hasIssue ? "有" : "无"} | 执行者标记:${exec} | 飞书负责人:${hasAssignee ? "有" : "无"}`);
  }
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
