import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { LayerId } from "@aigility-arch/core";
import type { SeamContext } from "@aigility-arch/core";
import {
  codexAgentService,
  codexAgentProvider,
} from "./codex-agent.js";

/** 最小 SeamContext 测试替身 */
function mockContext(): SeamContext {
  return {
    sessionId: "it-session",
    traceId: "it-trace",
    callerLayer: LayerId.Orchestration,
    addEffect: () => "effect-1",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: async () => ({ ok: false, error: "not wired in test" }),
  };
}

const codexAvailable = (): boolean => {
  const bin = process.env.CODEX_BIN ?? "codex";
  try {
    return spawnSync(bin, ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
};

describe("@orchestration/codex-agent 契约", () => {
  it("服务定义归属 Orchestration 层且版本/描述正确", () => {
    expect(codexAgentService.id).toBe("@orchestration/codex-agent");
    expect(codexAgentService.layer).toBe("orchestration");
    expect(codexAgentService.version).toBe("1.0.0");
    expect(typeof codexAgentService.description).toBe("string");
  });

  it("Provider 绑定到同一服务定义", () => {
    expect(codexAgentProvider.service).toBe(codexAgentService);
  });
});

describe("execute 边界校验", () => {
  it("空 prompt 返回 err 而非抛异常", async () => {
    const r = await codexAgentProvider.execute(
      { prompt: "   " },
      mockContext(),
    );
    expect(r.ok).toBe(false);
  });

  it("未实现的 thread resume 返回 err", async () => {
    const r = await codexAgentProvider.execute(
      { prompt: "hi", threadId: "some-thread-id" },
      mockContext(),
    );
    expect(r.ok).toBe(false);
  });
});

describe("health 探针", () => {
  it("codex 已安装时 health 返回 healthy", async () => {
    const h = await codexAgentProvider.health();
    expect(h).toHaveProperty("healthy");
    expect(h).toHaveProperty("detail");
    expect(h).toHaveProperty("checkedAt");
    if (codexAvailable()) {
      expect(h.healthy).toBe(true);
    }
  });
});

describe("集成验证（真实驱动 Codex CLI）", () => {
  it.skipIf(!codexAvailable())(
    "trivial 任务完成 JSONL 全链路往返",
    { timeout: 120_000 },
    async () => {
      const marker = "CODEX_IT_OK";
      const r = await codexAgentProvider.execute(
        {
          prompt: `Reply with exactly the token: ${marker}`,
          cwd: process.cwd(),
          sandboxMode: "read-only",
          timeoutMs: 100_000,
        },
        mockContext(),
      );

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.threadId).toBeTruthy();
        expect(r.value.text.length).toBeGreaterThan(0);
        expect(r.value.text).toContain(marker);
      }
    },
  );
});