/**
 * @aigility-harness/layer-action — 行动执行工具层
 *
 * 提供工具执行占位能力（@action/tool-execution）。
 * 行动层是链路末端，执行编排层交付的具体操作，不反向消费编排能力。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import {
  textToSpeechService,
  textToSpeechProvider,
  type TextToSpeechRequest,
  type TextToSpeechResponse,
} from "./text-to-speech.js";
import { minimaxTtsProvider } from "./text-to-speech-minimax.js";
import {
  codexAgentService,
  codexAgentProvider,
  type CodexAgentRequest,
  type CodexAgentResponse,
  type CodexAgentItem,
  type CodexAgentTurnUsage,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codex-agent.js";
import {
  zcodeAgentService,
  zcodeAgentProvider,
  zcodeAgentRef,
  type ZcodeAgentRequest,
  type ZcodeAgentResponse,
} from "./zcode-agent.js";
import {
  claudeAgentService,
  claudeAgentProvider,
  claudeAgentRef,
  type ClaudeAgentRequest,
  type ClaudeAgentResponse,
} from "./claude-agent.js";
import {
  timemMemoryService,
  timemMemoryWriteService,
  createTimemMemoryProvider,
  createTimemMemoryWriteProvider,
  type TimemMemoryClientLike,
} from "./timem-memory-provider.js";
export {
  timemMemoryService,
  timemMemoryWriteService,
  createTimemMemoryProvider,
  createTimemMemoryWriteProvider,
  type TimemMemoryClientLike,
};
import { TimemClient } from "@timem/dsh-plugin-timem";

export { textToSpeechService, textToSpeechProvider, minimaxTtsProvider };
export type { TextToSpeechRequest, TextToSpeechResponse };

// 编码代理工人（D5：领活 → 执行 → 交产出，spawn CLI 子进程产生真实副作用）
export { codexAgentService, codexAgentProvider };
export type {
  CodexAgentRequest,
  CodexAgentResponse,
  CodexAgentItem,
  CodexAgentTurnUsage,
  CodexApprovalPolicy,
  CodexSandboxMode,
};
export { zcodeAgentService, zcodeAgentProvider, zcodeAgentRef };
export { claudeAgentService, claudeAgentProvider, claudeAgentRef };
export type { ZcodeAgentRequest, ZcodeAgentResponse };
export type { ClaudeAgentRequest, ClaudeAgentResponse };

// 沙箱快照备份工具（编码代理改文件前自动快照；版本回滚 UI 复用）
export { backupHtmlFiles } from "./sandbox-backup.js";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface ToolExecutionRequest {
  /** 工具名称 */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
}

export interface ToolExecutionResponse {
  result: unknown;
  success: boolean;
  executedTool: string;
}

export const toolExecutionService: ServiceDefinition<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  id: "@action/tool-execution",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "工具执行能力（原型占位，返回参数回显）",
};

// ── Provider 实现 ────────────────────────────────────────────────

const toolExecutionProvider: Provider<
  ToolExecutionRequest,
  ToolExecutionResponse
> = {
  service: toolExecutionService,
  name: "action-tool-execution-stub",
  state: PluginState.Active,
  async execute(
    request: ToolExecutionRequest,
    _ctx: SeamContext,
  ): Promise<Result<ToolExecutionResponse>> {
    // 占位执行：回显工具名与参数
    return ok({
      result: { echoedArgs: request.args },
      success: true,
      executedTool: request.tool,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "stub tool execution ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/tool-execution",
  layer: LayerId.Action,
  description: "行动执行层：工具执行占位 + 文本转语音（msedge + MiniMax 双 Provider 热替换）+ 编码代理工人(codex/zcode/claude) + TiMEM 记忆检索/写入",
  version: "0.4.0",
  provides: [toolExecutionService, textToSpeechService, codexAgentService, zcodeAgentService, claudeAgentService, timemMemoryService, timemMemoryWriteService],
  consumes: [],
  preferredCarrier: CarrierKind.Subprocess,
};

// 环境变量指纹客户端: /dsh 页面保存配置后 env 会被原地更新,
// 检测指纹变化自动重建 TimemClient, 实现「保存配置即热生效」(无需重启)。
// searchMemory 带云端契约兼容: 插件发 query 字段, api.timem.cloud 要求 query_text —— 失败时自动兼容重试一次。
class EnvTimemClient implements TimemMemoryClientLike {
  private inner: TimemClient | null = null;
  private fp = "";

  private ensure(): TimemClient {
    const fp = `${process.env.TIMEM_API_KEY ?? ""}|${process.env.TIMEM_BASE_URL ?? ""}`;
    if (!this.inner || this.fp !== fp) {
      this.inner = new TimemClient({
        apiKey: process.env.TIMEM_API_KEY ?? "",
        baseUrl: process.env.TIMEM_BASE_URL,
      });
      this.fp = fp;
    }
    return this.inner;
  }

  async searchMemory(req: Parameters<TimemMemoryClientLike["searchMemory"]>[0]): Promise<unknown> {
    const client = this.ensure();
    try {
      return await client.searchMemory({
        query: req.query,
        user_id: req.user_id ?? "anonymous",
        agent_id: req.agent_id,
        limit: req.limit ?? 5,
      });
    } catch (primaryErr) {
      const base = (process.env.TIMEM_BASE_URL ?? "http://localhost:8001").replace(/\/$/, "");
      const resp = await fetch(`${base}/api/v1/memory/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": process.env.TIMEM_API_KEY ?? "" },
        body: JSON.stringify({
          user_id: req.user_id,
          agent_id: req.agent_id,
          query_text: req.query,
          limit: req.limit ?? 5,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await resp.text();
      if (!resp.ok) throw primaryErr;
      try {
        return JSON.parse(text);
      } catch {
        throw primaryErr;
      }
    }
  }

  addMemory(opts: Parameters<TimemClient["addMemory"]>[0]) {
    return this.ensure().addMemory(opts);
  }
}

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    // timem 客户端按环境变量构造 (装配方须在 bootstrap 前注入 TIMEM_API_KEY/BASE_URL,
    // appbase 在 initAppBackend 里从 dsh_plugins 表桥接, 且保存配置时原地更新 env);
    // 未配置 key 时构造不报错, 调用期失败由 provider 内部捕获并以 ok:false 降级
    const timemClient = new EnvTimemClient();
    return [
      toolExecutionProvider,
      textToSpeechProvider,
      minimaxTtsProvider,
      codexAgentProvider,
      zcodeAgentProvider,
      claudeAgentProvider,
      createTimemMemoryProvider(timemClient),
      createTimemMemoryWriteProvider(timemClient),
    ];
  },
  getState(): PluginState {
    return pluginState;
  },
};
