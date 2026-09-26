/**
 * @action/dsh-tool — DSH ctx.tools → harness Seam 桥（示例本地插件, 不改框架包）
 *
 * DSH 侧（appbase dsh-host）的 dsh-mcp-client 把外部 MCP server 工具注册到
 * ctx.tools（公共名 mcp__<serverName>__<rawName>）；本桥把它收敛成 Seam 能力，
 * 五域数字员工与平台 API（/api/aigility/dsh/tools）经 ctx.call 消费：
 *   - action:"list"  枚举宿主当前可见工具（含参数 schema）
 *   - action:"call"  直调单工具（args 为该工具 inputSchema 的 JSON 值）
 * 宿主未启动 / dsh-tools 未装载时降级返回（hostAlive:false / ok:false），不抛错。
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
  PluginManifest,
  LayerPlugin,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

import { dshListTools, dshCallTool, dshStatus, type DshToolInfo } from "@aigility-harness/appbase/dsh-host";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface DshToolBridgeRequest {
  action: "list" | "call";
  /** action:"call" — 工具公共名（mcp__<serverName>__<rawName>） */
  name?: string;
  /** action:"call" — 工具入参（其 inputSchema 的 JSON 值） */
  args?: Record<string, unknown>;
}

export interface DshToolBridgeResponse {
  ok: boolean;
  /** DSH 宿主是否存活（false = 未启动任何 cordis 上下文） */
  hostAlive: boolean;
  /** dsh-tools 服务是否已装载 */
  toolsMounted: boolean;
  /** action:"list" — 工具清单 */
  tools?: DshToolInfo[];
  /** action:"call" — 工具返回值（MCP content 数组 / structuredContent） */
  value?: unknown;
  error?: string;
}

export const dshToolBridgeService: ServiceDefinition<DshToolBridgeRequest, DshToolBridgeResponse> = {
  id: "@action/dsh-tool",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "DSH 工具桥：枚举/直调宿主 ctx.tools（dsh-mcp-client 注册的 MCP 工具等）",
};

// ── Provider 实现 ────────────────────────────────────────────────

const providerName = "action-dsh-tool-bridge";

export const dshToolBridgeProvider: Provider<DshToolBridgeRequest, DshToolBridgeResponse> = {
  service: dshToolBridgeService,
  name: providerName,
  state: PluginState.Active,
  async execute(
    request: DshToolBridgeRequest,
    _ctx: SeamContext,
  ): Promise<Result<DshToolBridgeResponse>> {
    const status = dshStatus();
    const hostAlive = status.hostAlive;
    const toolsRec = status.plugins["tools"];
    const toolsMounted = hostAlive && Boolean(toolsRec?.at) && !toolsRec?.error;
    if (request.action === "list") {
      return ok({ ok: true, hostAlive, toolsMounted, tools: dshListTools() });
    }
    if (request.action === "call") {
      if (!request.name?.trim()) {
        return ok({ ok: false, hostAlive, toolsMounted, error: "call 需要 name" });
      }
      const r = await dshCallTool(request.name.trim(), request.args ?? {});
      return ok({ ok: r.ok, hostAlive, toolsMounted, value: r.value, error: r.error });
    }
    return ok({ ok: false, hostAlive, toolsMounted, error: `未知 action: ${String(request.action)}` });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "dsh-tool bridge ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单（示例本地 LayerPlugin, 随主装配注入 bootstrap） ──────

export const manifest: PluginManifest = {
  name: "@action/dsh-tool",
  layer: LayerId.Action,
  description: "行动执行层：DSH ctx.tools 工具桥（MCP 工具的 Seam 消费入口）",
  version: "1.0.0",
  provides: [dshToolBridgeService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

export const dshToolBridgePlugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [dshToolBridgeProvider];
  },
  getState(): PluginState {
    return PluginState.Active;
  },
};
