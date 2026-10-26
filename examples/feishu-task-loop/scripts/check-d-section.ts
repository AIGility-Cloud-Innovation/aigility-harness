/** 查 D 执行中分组里的所有卡 + 台账状态 */
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

const TARGET = { name: "AIGility-Cloud-Innovation", section: "D 执行中" };
const lists = (await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" })).data?.items ?? [];
const list = lists.find((x: any) => x.name === TARGET.name);
if (!list) throw new Error("清单不存在");

const secs = (await api("GET", "/open-apis/task/v2/sections", {
  resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id",
})).data?.items ?? [];
const sec = secs.find((s: any) => s.name === TARGET.section);
console.log(`清单=${list.name} 分组=${TARGET.section} guid=${sec?.guid}`);

const tasks = (await api("GET", "/open-apis/task/v2/tasks", {
  page_size: "100",
  resource_type: "tasklist",
  resource_id: list.guid,
  user_id_type: "open_id",
})).data?.items ?? [];
console.log(`\n清单内任务数: ${tasks.length}`);

// 逐个查 membership，过滤出在 D 组的
let n = 0;
for (const t of tasks) {
  const d = await api("GET", `/open-apis/task/v2/tasks/${t.guid}`, { user_id_type: "open_id" });
  const task = d?.data?.task;
  const inD = (task?.tasklists ?? []).some((m: any) => m.section_guid === sec?.guid);
  if (inD) {
    n++;
    const desc = String(task.description ?? "");
    const exec = (desc.match(/执行者[：:]\s*(\S+)/) ?? [])[1] ?? "(无)";
    console.log(`\n[D组] ${String(task.summary).slice(0, 60)}`);
    console.log(`      guid=${task.guid} | 执行者=${exec} | 完成=${task.completed_at ? "是" : "否"}`);
  }
}
console.log(`\nD 组共 ${n} 张`);
