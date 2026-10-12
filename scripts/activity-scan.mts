// 飞书任务今日更新时间：谁上午在动任务（真人活动足迹）· 2026-10-10 12:31
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

const TASKLISTS = ["AIGility-Cloud-Innovation", "TiMEM-AI"];

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "activity-scan", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("activity-scan", LayerId.Action);
  const call = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown; msg?: string }) : undefined;
  };
  const lists = ((await call({ method: "GET", path: "/open-apis/task/v2/tasklists", query: { page_size: 50, user_id_type: "open_id" }, identity: "user" })) as { data?: { items?: Array<{ guid?: string; name?: string }> } })?.data?.items ?? [];
  for (const tl of lists) {
    if (!TASKLISTS.includes(tl.name ?? "")) continue;
    const secs = ((await call({ method: "GET", path: "/open-apis/task/v2/sections", query: { resource_type: "tasklist", resource_id: tl.guid, page_size: 50, user_id_type: "open_id" }, identity: "user" })) as { data?: { items?: Array<{ guid?: string; name?: string }> } })?.data?.items ?? [];
    for (const s of secs) {
      const sn = (s.name ?? "").trim();
      if (!/^[PCDA]/.test(sn)) continue;
      const tasks = ((await call({ method: "GET", path: `/open-apis/task/v2/sections/${s.guid}/tasks`, query: { page_size: 100, user_id_type: "open_id" }, identity: "user" })) as { data?: { items?: Array<{ guid?: string; summary?: string; updated_at?: string; created_at?: string }> } })?.data?.items ?? [];
      for (const t of tasks) {
        const upd = (t.updated_at ?? "").slice(0, 16);
        const today = upd.startsWith("2026-10-10");
        const createdToday = (t.created_at ?? "").startsWith("2026-10-10");
        if (today || createdToday) {
          console.log(`[${tl.name}|${sn}] ${upd}${createdToday ? "(新)" : ""} ${(t.summary ?? "").slice(0, 30)}`);
        }
      }
    }
  }
}
void main();
