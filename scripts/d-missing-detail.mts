// 取 D 组缺工单任务的完整标题+描述（只读）· 2026-10-10
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "d-detail", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("d-detail", LayerId.Action);
  const feishu = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown }) : { code: -1, msg: r.error };
  };
  const lr = await feishu({ method: "GET", path: "/open-apis/task/v2/tasklists", query: { page_size: 50 } });
  const lists = ((lr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
  for (const list of lists) {
    if (!["TiMEM-AI", "AIGility-Cloud-Innovation"].includes(list.name ?? "")) continue;
    const sr = await feishu({ method: "GET", path: "/open-apis/task/v2/sections", query: { resource_type: "tasklist", resource_id: list.guid, page_size: 50 } });
    const sections = ((sr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
    const doing = sections.find((s) => s.name?.trim() === "D 执行中");
    if (!doing?.guid) continue;
    const tr = await feishu({ method: "GET", path: `/open-apis/task/v2/sections/${doing.guid}/tasks`, query: { page_size: 100, user_id_type: "open_id" } });
    const tasks = ((tr.data as { items?: Array<{ guid?: string; summary?: string; description?: string }> })?.items ?? []);
    for (const t of tasks) {
      const s = t.summary ?? "";
      if (!/\[[^\]#/]+\/[^\]#/]+#\d+\]/.test(s)) {
        console.log(`\n=== [${list.name}] ${s}`);
        console.log(`    guid: ${t.guid}`);
        console.log(`    描述: ${(t.description ?? "（空）").slice(0, 200)}`);
      }
    }
  }
}
void main();
