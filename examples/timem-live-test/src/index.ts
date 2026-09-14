/**
 * timem-live-test — 本地 dsh-plugin-timem 插入 aigility-harness 运行时, 对真实 TiMEM Engine 实测传参契约
 *
 * 运行:
 *   TIMEM_API_KEY=sk-xxx TIMEM_BASE_URL=https://api.timem.cloud pnpm start
 *
 * 每个 API 用两种方式调用并对照:
 *   [插件] ctx.timem.xxx(...)  — dsh-plugin-timem 0.1.0 现行传参
 *   [对照] 原生 fetch          — 服务端 (timem-platform-backend) schema 期望的契约
 */

import { Context } from "@deepseek-ai/cordis";
import { timemPlugin } from "@timem/dsh-plugin-timem";

const BASE = (process.env.TIMEM_BASE_URL ?? "https://api.timem.cloud").replace(/\/$/, "");
const KEY = process.env.TIMEM_API_KEY ?? "";
const UID = "dsh-plugin-live-test";

interface StepResult {
  label: string;
  ok: boolean; // 请求是否按预期完成 (无论状态码)
  detail: string;
}

async function raw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

function clip(s: string, n = 420): string {
  return s.replace(/\s+/g, " ").slice(0, n);
}

const results: StepResult[] = [];
async function step(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail });
    console.log(`  ✔ ${label}\n    ${clip(detail)}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ label, ok: false, detail });
    console.log(`  ✘ ${label}\n    ${clip(detail)}`);
  }
}

async function main() {
  console.log(`═══ timem-live-test — 插入 harness 运行时, 实测 ${BASE} ═══\n`);
  if (!KEY) {
    console.error("缺少 TIMEM_API_KEY 环境变量");
    process.exit(1);
  }

  // [0] 插入插件 (与 dsh-timem-demo 相同的 cordis 方式)
  const root = new Context();
  await root.plugin(timemPlugin, { apiKey: KEY, baseUrl: BASE, defaultDomain: "app" });
  console.log(`[0] 插件已插入: ctx.timem = ${root.timem?.constructor?.name}\n`);

  // [1] 规则列表 — GET /api/v1/rules (查询参数方式, 理论上最不容易出错)
  await step("[插件] listRules({page:1, page_size:3})", async () => {
    const rules = await root.timem.listRules({ page: "1", page_size: "3" });
    return `插件解析出 ${rules.length} 条规则: ${JSON.stringify(rules).slice(0, 300)}`;
  });
  await step("[对照] raw GET /api/v1/rules?page=1&page_size=3", async () => {
    const r = await raw("GET", "/api/v1/rules?page=1&page_size=3");
    return `HTTP ${r.status}: ${clip(r.text, 500)}`;
  });

  // [2] 记忆搜索 — 插件发 query 字段
  await step("[插件] search({user_id, query: '测试用户偏好'})", async () => {
    const r = await root.timem.search({ user_id: UID, query: "测试用户偏好", limit: 3 });
    return `memories=${r.memories?.length ?? "N/A"} total=${r.total ?? "?"}: ${JSON.stringify(r).slice(0, 400)}`;
  });
  await step("[对照] raw POST /api/v1/memory/search 用 query_text", async () => {
    const r = await raw("POST", "/api/v1/memory/search", {
      user_id: UID,
      query_text: "测试用户偏好",
      limit: 3,
    });
    return `HTTP ${r.status}: ${clip(r.text, 500)}`;
  });
  await step("[插件] search 带 level: 1 (数字)", async () => {
    const r = await root.timem.search({ user_id: UID, query: "测试", level: 1, limit: 3 });
    return `memories=${r.memories?.length ?? "N/A"}`;
  });

  // [3] 记忆创建 — 插件发 content 字段
  await step("[插件] add({user_id, content: {...}, layer: 1})", async () => {
    const r = await root.timem.add({
      user_id: UID,
      content: { type: "interaction", text: "dsh-plugin-timem 集成测试记忆" },
      domain: "app",
      layer: 1,
    });
    return `status=${r.status} task_id=${r.task_id ?? "N/A"}`;
  });
  await step("[对照] raw POST /api/v1/memory/ 用 expert_id/session_id/messages", async () => {
    const r = await raw("POST", "/api/v1/memory/", {
      user_id: UID,
      expert_id: "dsh-live-test-expert",
      session_id: `sess-${Date.now()}`,
      messages: [
        { role: "user", content: "记住：我正在测试 dsh-plugin-timem 插件" },
        { role: "assistant", content: "好的，已了解" },
      ],
    });
    return `HTTP ${r.status}: ${clip(r.text, 500)}`;
  });

  // [4] 规则召回 — 插件发 scene 字段
  await step("[插件] recallRules({scene: '简历评估'})", async () => {
    const rules = await root.timem.recallRules({ user_id: UID, scene: "简历评估", limit: 5 });
    return `插件解析出 ${rules.length} 条规则`;
  });
  await step("[对照] raw POST /api/v1/rules/recall 用 query_text", async () => {
    const r = await raw("POST", "/api/v1/rules/recall", { user_id: UID, query_text: "简历评估" });
    return `HTTP ${r.status}: ${clip(r.text, 500)}`;
  });

  // [5] 规则创建 — 插件发 rule_type/trigger/action/description
  await step("[插件] createRule({rule_type, trigger, action, description})", async () => {
    const rule = await root.timem.createRule({
      user_id: UID,
      rule_type: "style",
      trigger: { intent: "dsh-live-test" },
      action: { reply: "ok" },
      description: "dsh-plugin-timem 集成测试规则",
    });
    return `rule_id=${(rule as { rule_id?: string }).rule_id ?? JSON.stringify(rule).slice(0, 200)}`;
  });
  await step("[对照] raw POST /api/v1/rules 用 name/situation/lesson/trigger_tags", async () => {
    const r = await raw("POST", "/api/v1/rules", {
      user_id: UID,
      name: `dsh-live-test-rule-${Date.now() % 100000}`,
      situation: "用户在测试 dsh-plugin-timem 插件的规则创建",
      lesson: "对照测试：服务端要求 name/situation/lesson/trigger_tags",
      trigger_tags: ["test"],
    });
    return `HTTP ${r.status}: ${clip(r.text, 500)}`;
  });

  // [6] 汇总
  console.log("\n═══ 汇总 ═══");
  for (const r of results) {
    console.log(`${r.ok ? "✔" : "✘"} ${r.label}`);
  }
  await root.fiber.dispose();
}

main().catch((e) => {
  console.error("测试脚本异常:", e);
  process.exit(1);
});
