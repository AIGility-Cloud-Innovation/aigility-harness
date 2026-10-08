import { describe, it, expect, vi, afterEach } from "vitest";
import { LayerId } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";
import {
  piAgentService,
  piAgentProvider,
  buildPiArgs,
} from "./pi-agent.js";

/** 最小 SeamContext 测试替身（pi-agent 不消费其他 seam 服务） */
function mockContext(): SeamContext {
  return {
    sessionId: "it-session",
    traceId: "it-trace",
    callerLayer: LayerId.Action,
    addEffect: () => "effect-1",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: (async () => ({ ok: true })) as unknown as SeamContext["call"],
  } as unknown as SeamContext;
}

describe("@action/pi-agent 契约", () => {
  it("服务定义归属 Action 层且版本/描述正确", () => {
    expect(piAgentService.id).toBe("@action/pi-agent");
    expect(piAgentService.layer).toBe("action");
    expect(piAgentService.version).toBe("1.0.0");
    expect(typeof piAgentService.description).toBe("string");
  });

  it("Provider 绑定到同一服务定义", () => {
    expect(piAgentProvider.service).toBe(piAgentService);
  });

  it("buildPiArgs：print + no-session（工人临态），cwd 不经 CLI（spawn 选项决定）", () => {
    // 本用例断言「无任何 model 来源时不传 --model」，前提是 PI_AGENT_MODEL
    // 真的不存在——否则宿主/CI 导出的同名变量会注入 --model 而假性失败
    // （2026-10-07 定位：注入点即 process.env 本身，与 persona 同一类问题）。
    // 不能用 vi.stubEnv(name, "")：空串仍是「已定义」，而 pi-agent 用 ?? 判空，
    // 空串会被当成合法模型名传下去。
    const had = Object.prototype.hasOwnProperty.call(process.env, "PI_AGENT_MODEL");
    const prev = process.env.PI_AGENT_MODEL;
    delete process.env.PI_AGENT_MODEL;
    try {
      expect(buildPiArgs("任务提示词", "/tmp/any")).toEqual(["--print", "--no-session", "任务提示词"]);
    } finally {
      if (had) process.env.PI_AGENT_MODEL = prev;
      else delete process.env.PI_AGENT_MODEL;
    }
  });

  it("buildPiArgs：请求级 model 透传为 --model", () => {
    expect(buildPiArgs("任务", "/tmp", "harness-gateway/ksyun-deepseek-v4-flash")).toEqual([
      "--print",
      "--no-session",
      "--model",
      "harness-gateway/ksyun-deepseek-v4-flash",
      "任务",
    ]);
  });

  it("buildPiArgs：PI_AGENT_MODEL env 兜底", () => {
    vi.stubEnv("PI_AGENT_MODEL", "harness-gateway/qwen-turbo");
    expect(buildPiArgs("任务", "/tmp")).toEqual([
      "--print",
      "--no-session",
      "--model",
      "harness-gateway/qwen-turbo",
      "任务",
    ]);
  });

  it("空 prompt → ok:false，不 spawn", async () => {
    const r = await piAgentProvider.execute({ prompt: "   " }, mockContext());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("prompt is required");
  });
});
