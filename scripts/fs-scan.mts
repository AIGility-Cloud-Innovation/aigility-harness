// 只读探察：TiMEM-AI 清单 P/D/C/A 各组任务 + 执行人判定 + 是否可派发 · 2026-10-10
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "fs-scan", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("fs-scan", LayerId.Action);
  const call = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown; msg?: string }) : undefined;
  };
  const get = async <T>(path: string, query: Record<string, unknown>): Promise<T> => {
    const d = (await call({ method: "GET", path, query: { ...query, user_id_type: "open_id" }, identity: "user" })) as { data?: T };
    return (d?.data ?? {}) as T;
  };

  const lists = (await get<{ items?: Array<{ guid?: string; name?: string }> }>("/open-apis/task/v2/tasklists", { page_size: 50 })).items ?? [];
  for (const tl of lists) {
    if (!["TiMEM-AI", "AIGility-Cloud-Innovation"].includes(tl.name ?? "")) continue;
    console.log(`\n### 清单 ${tl.name} (${tl.guid})`);
    const secs = (await get<{ items?: Array<{ guid?: string; name?: string }> }>("/open-apis/task/v2/sections", { resource_type: "tasklist", resource_id: tl.guid, page_size: 50 })).items ?? [];
    for (const s of secs) {
      const sn = (s.name ?? "").trim();
      if (!/^[PCDA]/.test(sn)) continue;
      const tasks = (await get<{ items?: Array<{ guid?: string; summary?: string; members?: Array<{ role?: string; id?: string; name?: string }> }> }>(`/open-apis/task/v2/sections/${s.guid}/tasks`, { page_size: 100 })).items ?? [];
      console.log(`  [${sn}] ${tasks.length} 条:`);
      for (const t of tasks) {
        const asg = (t.members ?? []).find((m) => m.role === "assignee");
        const execMark = /执行者[:：]\s*(\S+)/.exec(t.summary ?? "");
        const dbl = /^\[([^\]#/]+)\/([^\]#/]+)#(\d+)\]/.test(t.summary ?? "");
        console.log(`    - ${(t.summary ?? "").slice(0, 46)} | 负责人=${asg?.name ?? asg?.id?.slice(0, 10) ?? "无"}${execMark ? ` | 执行者标记=${execMark[1]}` : ""}${dbl ? " | [双建]" : ""} | guid=${t.guid?.slice(0, 12)}…`);
      }
    }
  }
}
void main();
