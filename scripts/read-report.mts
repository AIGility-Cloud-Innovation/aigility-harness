
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";
loadEnv();
async function main() {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode:"prototype", profile:"chk", autoHotSwap:false, healthCheckIntervalMs:60000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("chk", LayerId.Action);
  const r = await ctx.call({ id:"@action/feishu-api", versionRange:"^1.0.0" }, {
    method:"GET", path:`/open-apis/task/v2/tasks/${process.env.TASK_GUID}`,
    query:{ user_id_type:"open_id" }, identity:"user" });
  const d = ((r.value as any)?.data?.task?.description ?? "") as string;
  console.log("总长度:", d.length);
  console.log("---- 全文 ----");
  console.log(d);
}
main();
