/** 一次性真实冒烟（有 DEEPSEEK_API_KEY 时才真正跑 LLM；跑完即删）。 */
import { it, expect } from "vitest";
import { dshWorkflowRun } from "./workflow-run.js";
import { loadDotEnv } from "./session-relay.js";

it(
  "dshWorkflowRun 真实冒烟：脚本 fan-out，返回 JSON result",
  { timeout: 240_000 },
  async () => {
    loadDotEnv("/home/johnny/AI/aigility-harness/.env");
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return; // 无密钥环境跳过
    const r = await dshWorkflowRun({
      script: `const r = await agent("用中文回答：1+1=? 只回数字", { label: "math" });\nreturn { answer: String(r).trim(), agentsStarted: 1 };`,
      meta: { name: "smoke-one", description: "单子代理冒烟" },
      args: {},
      dshHome: "/tmp/dsh-wf-smoke-home",
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      timeoutMs: 200_000,
    });
    console.log("SMOKE:", JSON.stringify({ ok: r.ok, parsed: r.parsed, result: r.result, error: r.error }));
    expect(r.ok).toBe(true);
    expect(r.parsed).toBe(true);
  },
);
