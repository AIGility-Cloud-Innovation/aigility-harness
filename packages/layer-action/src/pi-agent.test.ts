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
    expect(buildPiArgs("任务提示词", "/tmp/any")).toEqual(["--print", "--no-session", "任务提示词"]);
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
