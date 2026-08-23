# aigility-arch

> 五层可插拔 AI Agent 架构 —— 一套与具体工具、模型、运行时无关的**插件契约体系**。
>
> *Five-layer pluggable agent architecture: a kernel-agnostic, capability-contract system.*

---

## 这是什么 / 这不是什么

**这不是**「又一个接 Codex、接 LiteLLM、接 deepseek 的 Agent Demo」。

**这是**一套**契约镜像（contract mirror）**：把「推理」「协议翻译」「编排」「工具执行」「感知输入」这些能力抽象成**稳定的、带版本号的接口契约**，任何实现只要符合契约，就能插进去、换掉、并存热切换。

当前仓库里挂着的 Codex、LiteLLM、TTS、api-router 协议适配，**全部只是演示案例**——用来证明「这份契约能承载真实实现」。它们不是框架的一部分，随时可拆、可换、可同能力多实现并存。

> 一句话：**契约是主体，插件是过客。**

---

## 核心思想

### 1. 一切能力都是「契约」+「实现」

框架把世界分成三重角色，彼此**只靠能力 ID 通信，绝不互相 import 实现**：

| 角色 | 是什么 | 类比 |
|---|---|---|
| `ServiceDefinition` | 一个能力的**契约**：ID + 版本 + 请求/响应 Schema | 插座的标准规格 |
| `Provider` | 契约的一种**具体实现**：`execute()` + `health()` | 一款具体的电器 |
| `Consumer` | 契约的**使用方**：声明「我需要 @xx/yy」 | 插头 |

```ts
// 契约（服务定义，发布后不可变，破坏性变更需升大版本或换 ID）
const llmInference: ServiceDefinition<LlmReq, LlmRes> = {
  id: "@cognitive/llm-inference",
  version: "1.0.0",
  layer: LayerId.Cognitive,
  description: "LLM 推理能力",
  requestSchema:  { /* JSON Schema */ },
  responseSchema: { /* JSON Schema */ },
};

// 实现（Provider，可无限多个，运行时绑定/替换）
const myProvider: Provider<LlmReq, LlmRes> = {
  service: llmInference,
  name: "cognitive-llm-inference-my-impl",
  state: PluginState.Active,
  async execute(req, ctx) { /* 干活 */ },
  async health() { /* 探活 */ },
};
```

### 2. 多 Provider 可替换（热切换）

同一个能力 ID 下可以注册**任意多个 Provider**，`SeamRegistry` 负责绑定与切换：

- 换后端（LiteLLM → vLLM → 自建网关）——**Consumer 零改动**；
- 降级（真实 LLM 挂了 → 自动切 stub）——调度器按 `health()` 重绑；
- 灰度（stub 与真实实现并存）——按策略选 Provider。

### 3. 跨能力调用走 Seam，不 import 对方

Provider 之间**不 import、不知道对方实现、不知道端口**，只认能力 ID：

```ts
// 消费方在 execute() 里跨层调用，而不是 import 另一个 Provider
async execute(req, ctx) {
  const plan = await ctx.call<TaskPlanningReq, TaskPlanningRes>(
    { id: "@orchestration/task-planning", versionRange: "^1.0.0" },
    { goal: req.prompt },
  );
  // ... 再据此驱动外部执行器
}
```

`ctx.call()` 由 Seam 内部完成「resolve → 版本协商 → 健康检查 → 失败转移」，并**透传同一个 `traceId`**，一条逻辑请求全链路可追踪。

### 4. 内核无关（Kernel-Agnostic）

五层 + Seam 永不 import 具体内核。它们只依赖 `KernelAdapter` 接口。要换运行时内核：

- **prototype-mode**：进程内 `InMemoryKernelAdapter`（Thread 载体，秒级 demo）；
- **kernel-dsh**：基于 Cordis 的 `DshKernelAdapter`（生产内核宿主，35 测试通过）；
- 未来换别的内核：**实现 `KernelAdapter` 接口即可，层代码一行不动**。

---

## 五层架构

| 层 | `LayerId` | 角色 | 示例能力 |
|---|---|---|---|
| 认知 | `cognitive` | 大脑 · 推理决策 | `@cognitive/llm-inference` |
| 感知 | `perception` | 感官 · 人机输入 | `@perception/text-input`（未来语音/图像） |
| 编排 | `orchestration` | 小脑 · 规划路由 | `@orchestration/task-planning`、`@orchestration/codex-agent` |
| 行动 | `action` | 手脚 · 工具执行 | `@action/text-to-speech`、`@action/tool-executor` |
| 底座 | `infrastructure` | 地基 · 系统兼容 | `@infrastructure/config`、`logging`、`protocol-adapter` |

**运行载体（Carrier）**——插件跑在哪，由 manifest 声明、可按运行模式覆盖：

| Carrier | 适合 | 典型载体对象 |
|---|---|---|
| `thread` | 进程内纯计算 | 协议翻译、日志、config |
| `subprocess` | 需隔离的附属进程 | 文本归一化 |
| `daemon` | 本机守护进程 | 感知/行动层生产态 |
| `network-service` | 独立端口服务 | LiteLLM、HTTP ingress |

**运行模式（RunMode）**：`Prototype`（全进程内）与 `Production`（分布式 + 健康调度）。

---

## 接入指南：什么都能插

框架的接入面只有五个，任何东西都能落到其中一类。以下均以「演示案例」形式给出最小可复制的形状。

### A. 接入一个新的 LLM Gateway

实现一个 `Provider<LlmInferenceRequest, LlmInferenceResponse>`，内部 `fetch` 你的网关端点，注册到认知层即可。当前 `cognitive-llm-inference-litellm` 就是这样的**一个案例**——它不硬编码 URL/Key，按 `env → config/default.json → 内置默认` 三级读取，换网关只改配置。

### B. 接入一个新的编码 Agent / 外部执行器

把外部 agent（Codex CLI、Claude Code、OpenCode……）包装成一个 `Provider`：`execute()` 里 spawn 该运行时、说它的 wire 协议（JSONL / JSON-RPC / MCP / HTTP）。当前 `@orchestration/codex-agent` 即为案例——先 `ctx.call` 认知层做规划，再驱动 Codex CLI。

> 判断口径：**进程内插件树**（如 DSH/Cordis）→ 走内核挂载；**跨进程 RPC 服务**（如 codex app-server）→ 包成 Provider 说它自己的协议。两者都能桥接。

### C. 接入一个新的工具 / 动作

实现 `Provider<ToolReq, ToolRes>`，注册到行动层。`@action/text-to-speech`（源自 Open-LLM-VTuber 内化）即案例——把「一个独立项目的某个能力」抽成符合契约的 Provider。

### D. 接入一种新协议

实现 `Provider<ProtocolAdapterRequest, ProtocolAdapterResponse>`，做「外部协议 ↔ 内部标准」的翻译。当前 `@infrastructure/protocol-adapter` 内化了 api-router 的 Anthropic / OpenAI Responses / OpenAI Chat 三个方向，即案例。

### E. 换一个运行时内核

实现 `KernelAdapter` 接口（`registry` / `carriers` / `events` / `effects` / `createContext`），bootstrap 时注册。层代码零改动。

---

## 示例插件画廊（Reference Gallery）

> 这些是「契约能否承载真实实现」的**验证案例**，不是框架边界。每个都能被同契约的另一个 Provider 替换。

| 能力 ID | 当前 Provider | 载体 | 说明 |
|---|---|---|---|
| `@cognitive/llm-inference` | `stub` + `litellm` | Thread / NetworkService | 推理：确定性 echo 占位 + LiteLLM 真实推理并存 |
| `@infrastructure/protocol-adapter` | `anthropic` / `responses` / `openai` | Thread | api-router 协议翻译内化（纯函数） |
| `@orchestration/task-planning` | `basic` | Thread | 任务规划（走认知层推理） |
| `@orchestration/codex-agent` | `codex` | Subprocess | 驱动 Codex CLI，前置框架内规划 |
| `@action/text-to-speech` | `edge-tts` | Subprocess | Open-LLM-VTuber TTS 能力内化样板 |
| `@perception/text-input` | `basic` | Subprocess | 文本输入归一化 |
| `@infrastructure/config` / `logging` | `memory` / `console` | Thread | 底座基础服务 |

---

## 目录结构

```
packages/
├── core/                 # 内核无关的契约抽象（LayerId/Carrier/Seam/KernelAdapter/bootstrap）
├── kernel-dsh/           # DSH/Cordis 内核适配器（生产宿主）
├── kernel-inmemory/      # 进程内内存内核（part of prototype-mode）
├── layer-cognitive/      # 认知层：llm-inference（stub + litellm）
├── layer-perception/     # 感知层：text-input
├── layer-orchestration/  # 编排层：task-planning、codex-agent
├── layer-action/         # 行动层：text-to-speech、tool-executor
├── layer-infrastructure/ # 底座层：config、logging、protocol-adapter
└── prototype-mode/       # 原型 demo：组装五层、跑跨层全链路
config/default.json       # 外置连接配置（litellm url/key 等）
docs/                     # 设计文档
```

---

## 快速开始

```bash
# 依赖：Node >= 20，pnpm >= 9
pnpm install

# 运行原型 demo（组装五层、演示跨层调用、协议适配、codex 代理、TTS 全链路）
pnpm --filter prototype-mode start

# 类型检查（全仓）
pnpm -r run typecheck

# 测试
pnpm -r run test
```

demo 里第 8 步会真实穿越框架：`orchestration → ctx.call(cognitive) → litellmProvider → 远程 LLM`，而非 stub echo。

---

## 设计文档

- `docs/plugin-integration-design.md` —— api-router + LiteLLM + DSH 的插件化落地设计（v0.2）
- `docs/` 后续补充各 Provider 的接入协议细节

---

## License

MIT