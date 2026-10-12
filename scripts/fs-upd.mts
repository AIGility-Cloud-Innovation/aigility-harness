// 飞书任务逐条 GET 拿 updated_at（列表不带）+ 按负责人归类 · 2026-10-10 12:40
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

const TASKLISTS = ["AIGility-Cloud-Innovation", "TiMEM-AI"];

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "fs-upd", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("fs-upd", LayerId.Action);
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
      const tasks = ((await call({ method: "GET", path: `/open-apis/task/v2/sections/${s.guid}/tasks`, query: { page_size: 100, user_id_type: "open_id" }, identity: "user" })) as { data?: { items?: Array<{ guid?: string; summary?: string }> } })?.data?.items ?? [];
      for (const t of tasks) {
        const d = (await call({ method: "GET", path: `/open-apis/task/v2/tasks/${t.guid}`, query: { user_id_type: "open_id" }, identity: "user" })) as { data?: { task?: { updated_at?: string; created_at?: string; members?: Array<{ id?: string; role?: string; name?: string }> } } };
        const tk = d?.data?.task;
        if (!tk) continue;
        // 飞书 updated_at 是毫秒时间戳（1791603425982），先转 ISO 再比对日期
        const ms = Number(tk.updated_at ?? 0);
        const iso = new Date(ms).toISOString(); // UTC
        const cst = new Date(ms + 8 * 3600_000).toISOString(); // UTC+8
        const today = cst.startsWith("2026-10-10");
        if (!today) continue;
        const asg = tk.members?.find((m) => m.role === "assignee");
        console.log(`${cst.slice(11, 16)} | ${asg?.name ?? asg?.id?.slice(0, 8) ?? "无负责人"} | ${sn} | ${(t.summary ?? "").slice(0, 24)}`);
        void iso;
      }
    }
  }
}
void main();
