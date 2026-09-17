import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { LayerId } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";
import {
  codexAgentService,
  codexAgentProvider,
} from "./codex-agent.js";

/** 最小 SeamContext 测试替身；默认 planning（@cognitive/llm-inference）返回成功 */
function mockContext(callImpl?: SeamContext["call"]): SeamContext {
  const defaultCall = (async () => ({
    ok: true as const,
    value: { text: "mock plan", model: "deepseek-v4-pro" },
  })) as unknown as SeamContext["call"];
  return {
    sessionId: "it-session",
    traceId: "it-trace",
    callerLayer: LayerId.Action,
    addEffect: () => "effect-1",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: callImpl ?? defaultCall,
  };
}

const codexAvailable = (): boolean => {
  const bin = process.env.CODEX_BIN ?? "codex";
  try {
    // Windows: codex 是 .cmd 包装, 必须走 shell 才能探到 (与实现侧 useShell 一致)
    return (
      spawnSync(bin, ["--version"], {
        timeout: 5000,
        shell: process.platform === "win32",
      }).status === 0
    );
  } catch {
    return false;
  }
};

/**
 * 集成测试需 codex 的模型上游真实可用 (本机 ~/.codex/config.toml 指向
 * appbase 网关, 网关密钥与运行实例必须一致)。默认跳过保持套件绿色;
 * 显式 CODEX_IT=1 开启真跑 (慢, 单轮可达数分钟)。
 */
const codexItEnabled = (): boolean => process.env.CODEX_IT === "1";

describe("@action/codex-agent 契约", () => {
  it("服务定义归属 Action 层且版本/描述正确", () => {
    expect(codexAgentService.id).toBe("@action/codex-agent");
    expect(codexAgentService.layer).toBe("action");
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

  it("planning 失败时 execute 返回 err（不 spawn codex）", async () => {
    const call = (async () => ({
      ok: false as const,
      error: "LiteLLM unreachable",
    })) as unknown as SeamContext["call"];
    const r = await codexAgentProvider.execute(
      { prompt: "hello", cwd: process.cwd(), sandboxMode: "read-only" },
      mockContext(call),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("planning");
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
  it.skipIf(!codexAvailable() || !codexItEnabled())(
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
          // glm-4-flash: 账户免费额度可用; 默认 glm-4.6 需余额, 集成环境不稳定
          model: "glm-4-flash",
        },
        mockContext(),
      );

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.threadId).toBeTruthy();
        expect(r.value.text.length).toBeGreaterThan(0);
        expect(r.value.text).toContain(marker);
        // planning 经 mock 认知层成功，plan 字段应被填充
        expect(r.value.plan).toBe("mock plan");
      }
    },
  );

  it("thread resume: 两轮往返携带记忆（exec resume 子命令 + stdin `-`）", { timeout: 300_000, skip: !codexAvailable() || !codexItEnabled() }, async () => {
    const marker1 = "CODEX_RESUME_A";
    const first = await codexAgentProvider.execute(
      {
        prompt: `Remember this token for later: ${marker1}. Reply with exactly that token.`,
        cwd: process.cwd(),
        sandboxMode: "read-only",
        timeoutMs: 120_000,
        model: "glm-4-flash",
      },
      mockContext(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.threadId).toBeTruthy();

    const marker2 = "CODEX_RESUME_B";
    const second = await codexAgentProvider.execute(
      {
        prompt: `Reply with the token I gave you earlier and then this new token: ${marker2}`,
        threadId: first.value.threadId,
        cwd: process.cwd(),
        sandboxMode: "read-only",
        timeoutMs: 120_000,
        model: "glm-4-flash",
      },
      mockContext(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.threadId).toBeTruthy();
    expect(second.value.text).toContain(marker1);
    expect(second.value.text).toContain(marker2);
  });
});