/**
 * dsh-timem-demo — 演示 dsh-plugin-timem 插入 DeepSeek Harness 运行时
 *
 * 核心验证: @timem/dsh-plugin-timem 是 cordis 插件,
 * 可直接通过 与 kernel-dsh 相同的 @deepseek-ai/cordis Context 加载:
 *
 *   const root = new Context();            // DeepSeek Harness runtime
 *   await root.plugin(timemPlugin, cfg);   // 插件插入
 *   await root.timem.search({...});        // 使用记忆能力
 *
 * 运行:
 *   TIMEM_API_KEY=xxx TIMEM_BASE_URL=http://127.0.0.1:8001 pnpm start
 *   (无 key 时用 demo-server 的 mock 模式: TIMEM_DEMO_MOCK=1 pnpm start)
 */

import { Context } from "@deepseek-ai/cordis";
import { timemPlugin } from "@timem/dsh-plugin-timem";

export async function main() {
  console.log("═══ dsh-timem-demo: 插件插入 DeepSeek Harness 运行时 ═══\n");

  // 1. 创建 DeepSeek Harness 运行时 (与 kernel-dsh 相同的 cordis Context)
  const root = new Context();
  console.log("[1] 创建 cordis Context (DeepSeek Harness runtime)");

  // 2. 把 dsh-plugin-timem 插入运行时
  await root.plugin(timemPlugin, {
    apiKey: process.env.TIMEM_API_KEY ?? "demo-key",
    baseUrl: process.env.TIMEM_BASE_URL ?? "http://127.0.0.1:8001",
    defaultDomain: "demo",
  });
  console.log(`[2] 插件已插入: timemPlugin (filter=${(timemPlugin as unknown as { filter?: boolean }).filter})`);
  console.log("    ✩ 服务已注册: ctx.timem (officiation: TimemService extends Service)\n");

  // 3. 使用记忆能力 — 搜索
  console.log("[3] 调用 ctx.timem.search(...)");
  const memories = await root.timem.search({
    user_id: "demo-user-001",
    query: "用户的就业偏好",
    limit: 5,
  });
  console.log("    搜索结果:", JSON.stringify(memories, null, 2).slice(0, 400));

  // 4. 使用规则能力 — 召回
  console.log("\n[4] 调用 ctx.timem.recallRules(...)");
  const rules = await root.timem.recallRules({
    scene: "简历评估",
    user_id: "demo-user-001",
    limit: 5,
  });
  console.log("    召回规则:", JSON.stringify(rules, null, 2).slice(0, 400));

  // 5. 清理
  await root.fiber.dispose();
  console.log("\n[5] 运行时已释放 (fiber.dispose), 演示完成 ✅");
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  main().catch((e) => {
    console.error("demo 失败:", e);
    process.exit(1);
  });
}