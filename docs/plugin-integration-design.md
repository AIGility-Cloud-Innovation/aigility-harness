# 插件接入设计：api-router + LiteLLM + DSH

> 版本：v0.2 ｜ 日期：2026-08-22 ｜ 状态：草案待审
>
> v0.2 变更：api-router 从「感知层」改落「底座层 Infrastructure」（协议翻译是机器对机器，非人类交互）。

## 1. 概述

把本地已有的 `api-router`（协议适配代理）、`LiteLLM`（AI 网关）、`DSH`（Cordis 运行时内核）三层服务，映射到 aigility-arch 五层架构的插件体系。

- **DSH**：已是内核宿主（`KernelAdapter`），无需改动。
- **LiteLLM**：认知层 `@cognitive/llm-inference` 的真实推理 Provider。
- **api-router**：底座层 `@infrastructure/protocol-adapter` 的协议归一化 Provider。

目标：消除 api-router 的独立端口和独立服务形态，使其成为框架内的原生 Provider；LiteLLM 作为认知层真实推理能力接入。

## 2. 当前架构 vs 目标架构

```
── 当前（独立服务，3 端口） ──

  Claude Code ──→ api-router:4000 ──→ LiteLLM:48724 ──→ 华为云/金山云
  Codex ────────→                      (路由/限流/fallback)
  OpenCode ────→
  Hermes ──────→


── 目标（框架内插件，0 额外端口） ──

  外部调用者
      │
      ▼
  ┌────────────────────────────────────────────┐
  │  aigility-arch 内核（KernelAdapter）        │
  │                                            │
  │  ┌── Infrastructure（底座 / 系统地基）      │
  │  │   ├ logging (已有)                       │
  │  │   ├ config (已有)                        │
  │  │   ├ ★ protocol-adapter (api-router 变身) │
  │  │   │    Anthropic → OpenAI Chat           │
  │  │   │    Responses → OpenAI Chat           │
  │  │   │    OpenAI Chat (直通)                │
  │  │   └ http-ingress (新增，可选)            │
  │  │                                         │
  │  ┌── Perception（感知 / 感官，人类交互）    │
  │  │   ├ text-input (已有)                    │
  │  │   └ (未来) 语音 / 图像 / 手势输入         │
  │  │                                         │
  │  ┌── Cognitive（认知）                       │
  │  │   ├ llm-inference stub (已有)            │
  │  │   └ ★ llm-inference litellm (新增)      │
  │  │                                         │
  │  └── Orchestration / Action (不变)          │
  └────────────────────────────────────────────┘
              │ HTTP fetch
              ▼
        LiteLLM:48724 ──→ 华为云/金山云
        (保留为独立 NetworkService，
         框架通过 health() 探活感知其状态)
```

**关键变化**：
- api-router 从「独立 FastAPI 服务 (port 4000)」变成「底座层协议适配 Provider (Thread 载体)」
- LiteLLM 从「无框架感知的外部服务」变成「认知层 LLM 推理的 NetworkService Provider」
- HTTP 入口由框架内核提供（`@infrastructure/http-ingress`），api-router 协议适配只管翻译
- **0 额外端口**，日志走 EventBus 统一可观测

**为什么 api-router 落底座层而非感知层**：感知层（感官）处理的是「人」的输入——文本、语音、图像、手势，是人与系统的交互。api-router 的协议翻译（Anthropic ↔ OpenAI）是「机器对机器」的格式归一化，跟人无关，属于系统地基的兼容能力。底座层已有的 `@infrastructure/config`、`@infrastructure/logging` 都是同类系统基础服务，协议适配放这里语义一致。

## 3. DSH：已是内核宿主（无需改动）

DSH 在架构中的角色是 `KernelAdapter` 的实现，即五层架构运行的「地基」。`packages/kernel-dsh` 已实现 `DshKernelAdapter`（基于 Cordis 4.0），35 个测试全部通过。

| 项目 | 角色 | 现有接口 | 状态 |
|------|------|----------|------|
| DSH / kernel-dsh | 内核宿主 | `KernelAdapter` | ✅ 已接入，无需改动 |

DSH **不是**层插件，不与 ServiceDefinition/Provider 体系发生关系。它是 bootstrap 的 `config.kernel` 参数。

## 4. 跨能力调用的 Seam 机制（接线前提）

Provider 之间不直接 import、不互相知道对方实现。它们通过 **能力 ID + SeamRegistry** 解耦。

### 4.1 现状缺口：`SeamContext` 没有跨能力调用入口

读源码确认：`SeamContext` 目前只有 `sessionId / traceId / callerLayer / addEffect / emit / getState / setState`，**没有 `resolve()` 或 `call()` 方法**。`SeamRegistry.resolve()` 虽存在，但 bootstrap 未把它注入给任何 Provider。

证据：编排层的 `manifest.consumes` 已声明 `@cognitive/llm-inference`，但其 `execute()` 仍是固定 stub，从未真正调过 LLM。**即跨能力调用这条路目前只设计了一半，必须先补 plumbing。**

### 4.2 方案：给 `SeamContext` 增加 `call()` 方法

```typescript
// packages/core/src/seam.ts —— SeamContext 接口中追加
export interface SeamContext {
  sessionId: string;
  traceId: string;
  callerLayer: LayerId;
  addEffect(description: string, rollback: () => Promise<void>): string;
  emit(event: Omit<SystemEvent, "seq" | "timestamp">): void;
  getState<T>(key: string): T | undefined;
  setState<T>(key: string, value: T): void;

  /** 新增：按能力引用调用另一能力，Seam 内部 resolve + 健康检查 + failover */
  call<TReq, TRes>(ref: CapabilityRef, request: TReq): Promise<Result<TRes>>;
}
```

三个内核（`InMemoryKernelAdapter` / `DshSeamContext` / 其它）各实现一遍：闭包捕获 `registry`，内部 `resolve(ref)` → `provider.execute(request, ctx)`，并把同一个 `traceId` 传给下游，保证一条链路可追踪。

### 4.3 api-router ↔ LiteLLM 的握手三步

```
① 声明（manifest）      api-router 插件 consumes: [{ id: "@cognitive/llm-inference", versionRange: "^1.0.0" }]
② 注册（bootstrap）     LiteLLM Provider 以 service.id → Provider 落进 SeamRegistry（Map）
③ 调用（execute）      api-router Provider 调 ctx.call(llmInferenceRef, openaiBody)
```

api-router 的代码**不 import LiteLLM、不知道 48724、不知道对方 Provider 名**，只认 `@cognitive/llm-inference` 这个 ID。换后端（LiteLLM → vLLM）零改动。

## 5. LiteLLM → Layer-Cognitive（真实 LLM 推理）

### 5.1 现状

`@cognitive/llm-inference` 只有一个 stub Provider，返回 `[stub-llm] echo: <prompt>`。

### 5.2 新增 Provider：`cognitive-llm-inference-litellm`

**ServiceDefinition**：复用已有 `@cognitive/llm-inference`（同一能力 ID，两个 Provider 并存，Seam 支持热切换）。

**Provider（薄壳，约 30 行）**：

```typescript
// packages/layer-cognitive/src/litellm-provider.ts
const LITELLM_URL = "http://127.0.0.1:48724";

export const litellmProvider: Provider<LlmInferenceRequest, LlmInferenceResponse> = {
  service: llmInferenceService,       // @cognitive/llm-inference
  name: "cognitive-llm-inference-litellm",
  state: PluginState.Active,

  async execute(request, ctx) {
    const resp = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model ?? "gpt-4o",
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      }),
    });
    const data = await resp.json();
    ctx.emit({ type: "cognitive.llm.inference.completed", layer: LayerId.Cognitive,
      payload: { model: data.model, usage: data.usage }, traceId: ctx.traceId });
    return ok({
      text: data.choices?.[0]?.message?.content ?? "",
      tokens: data.usage?.total_tokens ?? 0,
      model: data.model ?? "unknown",
    });
  },

  async health() {
    const resp = await fetch(`${LITELLM_URL}/health/liveliness`);
    return { healthy: resp.ok,
      detail: resp.ok ? "LiteLLM live" : "LiteLLM unreachable",
      checkedAt: new Date().toISOString() };
  },
};
```

**载体**：`CarrierKind.NetworkService`。LiteLLM 保持独立进程（`litellm.service` 照跑），Provider 通过 HTTP 调用，`health()` 探活 `/health/liveliness`。

**LiteLLM 侧改动**：0 行 Python。只加这一个 TS 文件。

### 5.3 LiteLLM 的高级能力（模型路由 / fallback / 限流）

这些留在 LiteLLM 自己那层（`model_cost` + `router_settings`），不在框架里重复实现。认知层 Provider 只看到「一个返回好响应的 LLM 端点」。

| 能力 | 实现层 | 原因 |
|------|--------|------|
| 模型路由 | LiteLLM | 已有完善 router + model_group |
| fallback 重试 | LiteLLM | `num_retries` + `fallbacks` |
| 速率限制 | LiteLLM | `rpm` / `tpm` 配置 |
| 用量计费 | LiteLLM | SpendLogs + PostgreSQL |

## 6. api-router → Layer-Infrastructure（协议归一化）

### 6.1 现状

`/home/johnny/.local/share/api-router/proxy.py`：
- **387 行 FastAPI 服务**，监听 port 4000
- 三个端点：`POST /v1/messages`（Anthropic）、`POST /v1/chat/completions`（OpenAI）、`POST /v1/responses`（OpenAI Responses）
- 核心价值在 **4 个纯函数**：
  - `anthropic_to_openai(body)` — Anthropic Messages → OpenAI Chat request
  - `openai_response_to_anthropic(resp)` — OpenAI Chat response → Anthropic Messages
  - `responses_to_chat(body)` — OpenAI Responses → OpenAI Chat
  - `detect_caller(request)` — 调用者识别
- 其余代码：FastAPI endpoint boilerplate + httpx streaming 转发 + 环境变量加载

### 6.2 新增 Capability：`@infrastructure/protocol-adapter`

```typescript
// 协议方向枚举
type InboundProtocol = "anthropic" | "openai-chat" | "openai-responses";

// 协议适配请求
interface ProtocolAdapterRequest {
  protocol: InboundProtocol;              // 来源协议
  body: Record<string, unknown>;          // 原始请求体（协议特定格式）
  headers?: Record<string, string>;       // 请求头（用于调用者识别）
}

// 协议适配响应
interface ProtocolAdapterResponse {
  targetProtocol: "openai-chat";          // 目标协议（始终 openai-chat，后端是 LiteLLM）
  body: Record<string, unknown>;          // 转换后的请求体
  model: string;                          // 解析出的模型名
  caller: string;                         // 识别到的调用者
  stream: boolean;                        // 是否流式
}
```

### 6.3 三个 Provider（一个协议方向一个）

注册到同一个 `@infrastructure/protocol-adapter` 能力，运行时按 `protocol` 字段选择。

| Provider 名 | 方向 | 核心逻辑来源 | 非流式行数 | 流式 |
|---|---|---|---|---|
| `infrastructure-protocol-adapter-anthropic` | Anthropic → OpenAI | `anthropic_to_openai()` | ~80 | +~30 |
| `infrastructure-protocol-adapter-responses` | Responses → OpenAI | `responses_to_chat()` | ~60 | +~40 |
| `infrastructure-protocol-adapter-openai` | OpenAI → OpenAI | 直通 + model map | ~5 | ~15 |

**Provider 签名示例（Anthropic 方向）**：

```typescript
export const anthropicAdapterProvider: Provider<
  ProtocolAdapterRequest, ProtocolAdapterResponse
> = {
  service: protocolAdapterService,       // @infrastructure/protocol-adapter
  name: "infrastructure-protocol-adapter-anthropic",
  state: PluginState.Active,

  async execute(req, ctx) {
    ctx.emit({ type: "infrastructure.protocol.translate.started",
      layer: LayerId.Infrastructure,
      payload: { from: req.protocol, to: "openai-chat" }, traceId: ctx.traceId });

    const openaiBody = anthropicToOpenai(req.body);

    // 走 Seam 调认知层 LLM 推理（不直连 48724）
    const llm = await ctx.call(llmInferenceRef, {
      model: openaiBody.model,
      messages: openaiBody.messages,
      maxTokens: openaiBody.max_tokens,
      temperature: openaiBody.temperature,
    });
    if (!llm.ok) return llm;

    ctx.emit({ type: "infrastructure.protocol.translate.completed",
      layer: LayerId.Infrastructure,
      payload: { from: req.protocol, caller: detectCaller(req.headers) },
      traceId: ctx.traceId });

    return ok({
      targetProtocol: "openai-chat",
      body: openaiResponseToAnthropic(llm.value),
      model: openaiBody.model,
      caller: detectCaller(req.headers),
      stream: false,
    });
  },
};
```

### 6.4 api-router 改造清单

| 步骤 | 内容 | 文件 |
|------|------|------|
| 1 | 提取 4 个纯函数逻辑到 TS，无 FastAPI 依赖 | `packages/layer-infrastructure/src/translate/{anthropic,responses,openai,caller}.ts` |
| 2 | 定义 ProtocolAdapterRequest/Response 类型 | `packages/layer-infrastructure/src/protocol-types.ts` |
| 3 | 定义 `@infrastructure/protocol-adapter` ServiceDefinition | `packages/layer-infrastructure/src/protocol-adapter-service.ts` |
| 4 | 实现 3 个 Provider（包装纯函数 + emit 日志） | `packages/layer-infrastructure/src/protocol-adapter-provider.ts` |
| 5 | 更新 `packages/layer-infrastructure/src/index.ts` 导出新 plugin | 追加到现有 plugin |
| 6 | 停止 api-router systemd service，验证框架内等效运行 | integration test |
| 7 | （可选）保留 proxy.py + feature flag 支持回退 | 不删旧代码 |

**不做的（本期）**：
- 不把 streaming（SSE）逻辑嵌入 Provider（Phase 1-2 只做非流式），流式是后续扩展
- 不修改 api-router 的 Python 代码（只移植纯函数逻辑到 TS，原服务保留可回退）

### 6.5 载体选择：Thread

- 协议翻译是纯 CPU 计算（JSON 解构 + 重映射），无 I/O、无本地状态
- Thread 载体零额外开销，`execute()` 同步完成（< 1ms）
- 与「感知层 text-input 用 Subprocess」不同——协议适配不需要隔离

### 6.6 调用者识别 → SeamContext 状态

`detect_caller()` 的 User-Agent 解析逻辑移入 Provider 内部。识别的 `caller` 通过 `ctx.setState("caller", caller)` 写入会话状态，后续 LiteLLM Provider 用 `ctx.getState("caller")` 获取，注入 LiteLLM 的 `user` 字段做用量追踪。

## 7. HTTP Ingress（Phase 4）

当前框架没有 HTTP 入口（prototype demo 全进程内调用）。api-router 的 4000 端口退役需要一个替身。

**方案**：新增 `@infrastructure/http-ingress` 能力，Provider 用 `NetworkService` 载体监听一个端口（如 4000）。收到 HTTP 请求后：

1. 解析 method + path + body + headers
2. 调 `@infrastructure/protocol-adapter` 做协议翻译
3. 拿翻译后的 OpenAI Chat body → 调 `@cognitive/llm-inference` (LiteLLM)
4. LLM 响应反翻译后返回调用者

**注意区分**：`@infrastructure/protocol-adapter`（翻译逻辑，Thread）与 `@infrastructure/http-ingress`（HTTP 监听，NetworkService）是**两个独立能力**。api-router 原服务 = 二者之和，改造后拆成两块。Phase 2 先落协议翻译，Phase 4 再落 HTTP 监听，届时 api-router systemd service 正式退役。

## 8. 日志与可观测性

### 8.1 统一日志方案

api-router 用 `print()`、LiteLLM 用 Python logging，各自为政。框架内统一走 `SeamContext.emit()` → `EventBus`。

```typescript
ctx.emit({ type: "infrastructure.protocol.translate.started",
  layer: LayerId.Infrastructure,
  payload: { from: "anthropic", to: "openai-chat", model: "deepseek-v4-pro" },
  traceId: ctx.traceId });

ctx.emit({ type: "cognitive.llm.inference.completed",
  layer: LayerId.Cognitive,
  payload: { model: "deepseek-v4-pro", tokensIn: 1523, tokensOut: 487, durationMs: 2300 },
  traceId: ctx.traceId });
```

### 8.2 traceId 全链路

`SeamContext.traceId` 自动贯穿 Provider 调用链（配合 4.2 的 `ctx.call()` 传递同一 traceId）。底座层和认知层用同一 traceId，串联「谁调的 → 怎么翻译的 → LLM 耗时/token」。

### 8.3 事件类型（建议）

```typescript
// packages/core/src/events.ts（新建）
type SystemEvent =
  | { type: "infrastructure.protocol.translate.started"; from: InboundProtocol; to: "openai-chat"; model: string }
  | { type: "infrastructure.protocol.translate.completed"; from: InboundProtocol; caller: string; durationMs: number }
  | { type: "cognitive.llm.inference.started"; model: string; promptLength: number }
  | { type: "cognitive.llm.inference.completed"; model: string; tokensIn: number; tokensOut: number; durationMs: number }
  | { type: "carrier.health.changed"; carrier: string; healthy: boolean };
```

## 9. 载体分配汇总

| 能力 | Provider | 载体 | 原因 |
|------|----------|------|------|
| `@cognitive/llm-inference` | stub (已有) | Thread | 纯内存计算 |
| `@cognitive/llm-inference` | **litellm (新增)** | NetworkService | LiteLLM 是独立 HTTP 服务 |
| `@perception/text-input` | basic (已有) | Subprocess | 文本归一化 |
| `@infrastructure/logging` | console (已有) | Thread | 控制台输出 |
| `@infrastructure/config` | memory (已有) | Thread | 内存 Map |
| `@infrastructure/protocol-adapter` | **anthropic (新增)** | Thread | 纯 JSON 翻译，无 I/O |
| `@infrastructure/protocol-adapter` | **responses (新增)** | Thread | 同上 |
| `@infrastructure/protocol-adapter` | **openai (新增)** | Thread | 同上，基本直通 |
| `@infrastructure/http-ingress` | (Phase 4) | NetworkService | HTTP 监听端口 |

**关键**：LiteLLM 是唯一保留独立进程的组件（成熟网关，重写无意义）。api-router 的翻译逻辑完全适合 Thread 载体。

## 10. 实施计划

### Phase 0：Seam 接线补漏（0.5h，前置）
- [ ] 给 `SeamContext` 加 `call(ref, request)` 方法
- [ ] `InMemoryKernelAdapter` + `DshSeamContext` 各自实现（闭包捕获 registry）
- [ ] 补测试：orchestration 层 stub 改为真调 cognitive，验证跨层调用跑通

### Phase 1：LiteLLM Provider（1-2h）
- [ ] 新建 `packages/layer-cognitive/src/litellm-provider.ts`
- [ ] 实现 `litellmProvider`：HTTP fetch → LiteLLM → 解析响应
- [ ] `health()` 探活 `/health/liveliness`
- [ ] 注册到 `packages/layer-cognitive/src/index.ts` 的 `getProviders()`
- [ ] demo 验证 stub ↔ litellm 热切换

### Phase 2：api-router 协议适配 Provider → Infrastructure（2-4h）
- [ ] 新建 `packages/layer-infrastructure/src/protocol-types.ts`
- [ ] 新建 `protocol-adapter-service.ts` + `protocol-adapter-provider.ts`（3 Provider）
- [ ] 移植 4 个纯函数（Python → TS）
- [ ] 集成到 `packages/layer-infrastructure/src/index.ts`
- [ ] 翻译正确性测试（Anthropic body → OpenAI body 金标准对比）
- [ ] 原 `proxy.py` + systemd service 保留

### Phase 3：端到端验证（1h）
- [ ] e2e demo：HTTP ingress → protocol adapter → llm inference → 返回
- [ ] 验证 traceId 全链路 + EventBus 事件完整性

### Phase 4（未来）：HTTP Ingress
- [ ] 实现 `@infrastructure/http-ingress` Provider（NetworkService，监听端口）
- [ ] api-router systemd service 正式退役

## 11. 风险与开放问题

| 风险/问题 | 缓解 | 决策 |
|-----------|------|------|
| api-router Python → TS 移植遗漏边界情况 | Phase 2 对照 Python 逐函数移植 + 金标准测试 | — |
| LiteLLM 不可用时 demo 全挂 | stub Provider 保留，Seam 降级或手动切换 | — |
| 流式（SSE）翻译逻辑复杂 | Phase 1-2 只做非流式；流式后续单独处理 | — |
| `@cognitive/llm-inference` 接口不含 messages 数组，不支持多轮 + tool calls | Phase 1 保持现有 `prompt` 接口；多轮/tool 需扩接口（待定） | — |
| 跨能力调用 plumbing 缺失 | 已在 Phase 0 补 `SeamContext.call()` | ✅ 已定位 |
| HTTP Ingress 独立 port vs 嵌入进程 | Phase 4 再定，当前 api-router 继续跑 | 暂不决定 |
| proxy.py 与 TS Provider 并存回退策略 | 保留 proxy.py + systemd unit，环境变量切换 | — |