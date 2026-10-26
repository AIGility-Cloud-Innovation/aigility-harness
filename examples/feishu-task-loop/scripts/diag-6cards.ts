/** 逐张查 6 张卡的真实分组 + 台账状态 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";
import { readFileSync } from "node:fs";

loadEnv();
const BASE = "https://open.feishu.cn";
async function api(method: string, path: string, query?: Record<string, string>) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
  });
  return (await resp.json()) as any;
}

const GUIDS = [
  ["worker-team 分支冲突", "db025d48-3629-4895-9006-ead9c40ed834"],
  [".backups 排除", "b54dc668-7c9b-4d34-94b6-bfe96accd4c6"],
  ["待确认仓库顺序", "68e48f61-3f51-48f0-916a-a8d1f52ebef4"],
  ["台账禁直改", "93106120-8b2d-44b6-ad35-d4f09dc271e2"],
  ["PR 链接校验", "5472f852-234c-44bc-a2a3-46986d6923de"],
  ["OCR 落地", "b6b83dbf-6b62-4e28-94f9-f563b0c03196"],
];

// 清单/分组名映射
const lists = (await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" })).data?.items ?? [];
const listName = new Map<string, string>(lists.map((l: any) => [l.guid, l.name]));
const secName = new Map<string, string>();
for (const l of lists) {
  const secs = (await api("GET", "/open-apis/task/v2/sections", {
    resource_type: "tasklist", resource_id: l.guid, page_size: "50", user_id_type: "open_id",
  })).data?.items ?? [];
  for (const s of secs) secName.set(s.guid, s.name);
}

// 台账
const reg = JSON.parse(readFileSync("/home/johnny/AI/aigility-harness/config/task-registry.local.json", "utf8"));
const tasks: any[] = reg.tasks ?? [];
const byGuid = new Map<string, any>();
for (const t of tasks) {
  const g = t?.origin?.guid;
  if (g) byGuid.set(g, t);
}

console.log("=== 6 张卡：飞书分组 vs 台账状态 ===\n");
for (const [label, guid] of GUIDS) {
  const r = await api("GET", `/open-apis/task/v2/tasks/${guid}`, { user_id_type: "open_id" });
  const t = r?.data?.task;
  if (!t) { console.log(`${label}: 读取失败 ${r?.code}`); continue; }
  const ms = (t.tasklists ?? []).map((m: any) =>
    `${listName.get(m.tasklist_guid) ?? "?"}/${secName.get(m.section_guid) ?? "?"}`).join(", ");
  const rec = byGuid.get(guid);
  console.log(`${label}`);
  console.log(`   飞书: ${ms || "(未挂清单)"}`);
  console.log(`   台账: ${rec ? `status=${rec.status} uid=${rec.uid} attempts=${JSON.stringify(rec.attempts ?? {})}` : "❌ 未收编"}`);
}
