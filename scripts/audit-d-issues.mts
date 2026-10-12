// 只读盘点：D 组任务缺工单/缺链接情况（不动任何数据）· 2026-10-10
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";

import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

interface SectionTask {
  guid?: string;
  summary?: string;
  description?: string;
}

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "d-audit", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  // 装配 action 层（feishu-api + gitea-api）：只注册本审计要用的两个 provider
  const { feishuApiProvider, giteaApiProvider, feishuApiService, giteaApiService } = await import(
    "../packages/layer-action/src/index.js"
  );
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  await kernel.registry.register(giteaApiService, giteaApiProvider);
  const ctx = kernel.createContext("d-audit", LayerId.Action);
  const feishu = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown }) : { code: -1, msg: r.error };
  };

  // 1. 清单列表
  const lr = await feishu({ method: "GET", path: "/open-apis/task/v2/tasklists", query: { page_size: 50 } });
  const lists = ((lr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
  console.log("清单：", lists.map((l) => `${l.name}(${l.guid?.slice(0, 8)})`).join(", "));

  for (const list of lists) {
    // 2. sections（正确端点：/sections?resource_type=tasklist&resource_id=…）
    const sr = await feishu({ method: "GET", path: "/open-apis/task/v2/sections", query: { resource_type: "tasklist", resource_id: list.guid, page_size: 50 } });
    const sections = ((sr.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
    const doing = sections.find((s) => s.name?.trim() === "D 执行中");
    if (!doing?.guid) {
      console.log(`\n[${list.name}] 无 D 分组（sections: ${sections.map((s) => s.name).join("/")}）`);
      continue;
    }
    // 3. D 组任务
    const tr = await feishu({ method: "GET", path: `/open-apis/task/v2/sections/${doing.guid}/tasks`, query: { page_size: 100, user_id_type: "open_id" } });
    const tasks = ((tr.data as { items?: SectionTask[] })?.items ?? []).filter((t) => t.summary);
    console.log(`\n[${list.name}] D 组 ${tasks.length} 条:`);
    let missing = 0;
    for (const t of tasks) {
      const s = t.summary ?? "";
      const hasRef = /\[[^\]#/]+\/[^\]#/]+#\d+\]/.test(s);
      const hasLink = /工单链接[:：]\s*https?:\/\//.test(t.description ?? "");
      if (!hasRef || !hasLink) missing++;
      console.log(`  ${hasRef ? "✓" : "✗缺工单"}${hasLink ? "✓链接" : "✗无链接"} ${s.slice(0, 46)}`);
    }
    if (missing === 0) console.log("  （全部齐备）");
  }
}
void main();
