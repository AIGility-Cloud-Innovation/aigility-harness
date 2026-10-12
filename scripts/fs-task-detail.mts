// 只读：取任务 1abf4ff4-19b4-4cad-a0b4-fc334b45ee1b 全文（标题+描述）
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "fs-detail", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("fs-detail", LayerId.Action);
  const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, {
    method: "GET",
    path: "/open-apis/task/v2/tasks/1abf4ff4-19b4-4cad-a0b4-fc334b45ee1b",
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  if (!r.ok) { console.log("调用失败:", r.error); return; }
  const task = ((r.value as { data?: { task?: { summary?: string; description?: string; created_at?: string; creator?: string } } }).data)?.task;
  console.log("标题:", task?.summary);
  console.log("描述:", JSON.stringify(task?.description));
  console.log("创建时间(ms):", task?.created_at, "创建者:", task?.creator);
}
void main();
