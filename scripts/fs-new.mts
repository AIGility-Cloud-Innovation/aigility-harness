// 只读：找 TiMEM-AI 清单里最近创建的任务（用户刚建的那条）+ 详情 · 2026-10-10
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "fs-new", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("fs-new", LayerId.Action);
  const call = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown; msg?: string }) : undefined;
  };
  const get = async <T>(path: string, query: Record<string, unknown>): Promise<T> => {
    const d = (await call({ method: "GET", path, query: { ...query, user_id_type: "open_id" }, identity: "user" })) as { data?: T };
    return (d?.data ?? {}) as T;
  };

  const lists = (await get<{ items?: Array<{ guid?: string; name?: string }> }>("/open-apis/task/v2/tasklists", { page_size: 50 })).items ?? [];
  const tl = lists.find((x) => x.name === "TiMEM-AI");
  if (!tl?.guid) { console.log("清单未找到"); return; }
  const secs = (await get<{ items?: Array<{ guid?: string; name?: string }> }>("/open-apis/task/v2/sections", { resource_type: "tasklist", resource_id: tl.guid, page_size: 50 })).items ?? [];
  // 全清单任务（不走分节，直接列 tasklist 下所有 task）按 created_at 排序
  type TaskDetail = { guid?: string; summary?: string; description?: string; created_at?: string; completed_at?: string; members?: Array<{ role?: string; id?: string; name?: string }> };
  const all: Array<TaskDetail & { section?: string }> = [];
  for (const s of secs) {
    const items = (await get<{ items?: Array<{ guid?: string; summary?: string }> }>(`/open-apis/task/v2/sections/${s.guid}/tasks`, { page_size: 100 })).items ?? [];
    for (const it of items) {
      const d = await get<{ task?: TaskDetail }>(`/open-apis/task/v2/tasks/${it.guid}`, {});
      const tk = d.task;
      if (tk) all.push({ ...tk, section: (s.name ?? "").trim(), guid: it.guid });
    }
  }
  all.sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
  const cst = (ms?: string) => new Date(Number(ms ?? 0) + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
  console.log("最近创建的 5 条：");
  for (const t of all.slice(0, 5)) {
    const asg = (t.members ?? []).find((m) => m.role === "assignee");
    console.log(`  [${cst(t.created_at)}] ${t.section} | ${((t.summary ?? "")).slice(0, 50).replace(/\n/g, " ")}`);
    console.log(`     guid=${t.guid} 负责人=${asg?.name ?? asg?.id?.slice(0, 10) ?? "无"}`);
    if (t.description) console.log(`     描述: ${t.description.slice(0, 120).replace(/\n/g, " ⏎ ")}`);
  }
}
void main();
