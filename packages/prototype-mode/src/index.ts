/**
 * prototype-mode 入口 —— 组装五层插件并演示跨层调用
 *
 * 链路：orchestration 层 Consumer 调用 cognitive 层 Provider
 * （@orchestration/task-planning 消费 @cognitive/llm-inference）
 */

import {
  LayerId,
  RunMode,
  ok,
  err,
  bootstrap,
  shutdown,
  InProcessScheduler,
} from "@aigility-arch/core";
import type {
  KernelConfig,
  Consumer,
  SeamContext,
  Result,
  CapabilityRef,
} from "@aigility-arch/core";

import { InMemoryKernelAdapter } from "./in-memory-kernel.js";

import { plugin as infrastructurePlugin } from "@aigility-arch/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-arch/layer-cognitive";
import { plugin as perceptionPlugin } from "@aigility-arch/layer-perception";
import { plugin as orchestrationPlugin } from "@aigility-arch/layer-orchestration";
import { plugin as actionPlugin } from "@aigility-arch/layer-action";

import type {
  LlmInferenceRequest,
  LlmInferenceResponse,
} from "@aigility-arch/layer-cognitive";
import type {
  TaskPlanningRequest,
  TaskPlanningResponse,
  CodexAgentRequest,
  CodexAgentResponse,
} from "@aigility-arch/layer-orchestration";
import type {
  ProtocolAdapterRequest,
  ProtocolAdapterResponse,
} from "@aigility-arch/layer-infrastructure";
import type {
  TextToSpeechRequest,
  TextToSpeechResponse,
} from "@aigility-arch/layer-action";

function log(tag: string, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`  [${tag}] ${msg}`);
}

async function main(): Promise<void> {
  console.log("=== 五层可插拔 AI Agent 架构 · 原型模式 ===\n");

  // 1. 创建内存 KernelAdapter
  const kernel = new InMemoryKernelAdapter();
  console.log("1. KernelAdapter:", kernel.info.name, `v${kernel.info.version}`);

  // 2. 组装五层插件
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    perceptionPlugin,
    orchestrationPlugin,
    actionPlugin,
  ];
  console.log("2. 已加载插件:");
  for (const p of plugins) {
    log("plugin", `${p.manifest.name} (layer=${p.manifest.layer}, carrier=${p.manifest.preferredCarrier})`);
  }

  // 3. Bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "default",
    autoHotSwap: false,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);

  console.log("\n3. 启动 bootstrap...");
  const bootResult = await bootstrap({
    kernel,
    kernelConfig,
    plugins,
    scheduler,
  });
  if (!bootResult.ok) {
    console.error("   bootstrap 失败:", bootResult.error);
    process.exit(1);
  }
  console.log("   bootstrap 成功，kernel.isReady =", kernel.isReady());
  console.log("   已注册 Provider:");
  for (const p of plugins) {
    for (const prov of p.getProviders()) {
      log("seam", `${prov.service.id} -> ${prov.name}`);
    }
  }

  // 4. 演示跨层调用：orchestration Consumer -> cognitive Provider
  console.log("\n4. 跨层调用演示：orchestration -> cognitive");
  const ctx = kernel.createContext("session-001", LayerId.Orchestration);

  // 构造一个消费 @cognitive/llm-inference 的 Consumer
  const llmConsumer: Consumer<LlmInferenceRequest, LlmInferenceResponse> = {
    ref: { id: "@cognitive/llm-inference", versionRange: "^1.0.0" },
    layer: LayerId.Orchestration,
    async call(
      request: LlmInferenceRequest,
      callCtx: SeamContext,
    ): Promise<Result<LlmInferenceResponse>> {
      log("consumer", `orchestration 层发起调用 @cognitive/llm-inference`);
      callCtx.emit({
        type: "capability.invoke",
        layer: LayerId.Orchestration,
        payload: { capability: "@cognitive/llm-inference", model: request.model },
        traceId: callCtx.traceId,
      });
      // 走 Seam 跨能力调用（不 import 对方 Provider、不直连 48724）
      const execResult = await callCtx.call<LlmInferenceRequest, LlmInferenceResponse>(
        this.ref,
        request,
      );
      if (!execResult.ok) {
        return err(execResult.error);
      }
      callCtx.emit({
        type: "capability.response",
        layer: LayerId.Cognitive,
        payload: { text: execResult.value.text },
        traceId: callCtx.traceId,
      });
      return ok(execResult.value);
    },
  };

  const llmRequest: LlmInferenceRequest = {
    model: "qwen-turbo",
    messages: [
      { role: "system", content: "你是任务规划助手" },
      { role: "user", content: "请规划一个三步任务" },
    ],
    max_tokens: 128,
  };
  log("request", JSON.stringify(llmRequest));

  const llmResult = await llmConsumer.call(llmRequest, ctx);
  if (!llmResult.ok) {
    console.error("   跨层调用失败:", llmResult.error);
    process.exit(1);
  }
  console.log("   跨层调用结果:");
  log("response", `text = ${llmResult.value.text}`);
  log(
    "response",
    `model = ${llmResult.value.model}, usage = ${JSON.stringify(llmResult.value.usage)}`,
  );

  // 5. 顺带演示 action -> orchestration 跨层调用
  console.log("\n5. 跨层调用演示：action -> orchestration");
  const ctx2 = kernel.createContext("session-002", LayerId.Action);
  const planConsumer: Consumer<TaskPlanningRequest, TaskPlanningResponse> = {
    ref: { id: "@orchestration/task-planning", versionRange: "^1.0.0" },
    layer: LayerId.Action,
    async call(
      request: TaskPlanningRequest,
      callCtx: SeamContext,
    ): Promise<Result<TaskPlanningResponse>> {
      log("consumer", `action 层发起调用 @orchestration/task-planning`);
      const r = await kernel.registry.resolve<TaskPlanningRequest, TaskPlanningResponse>(this.ref);
      if (!r.ok) return err(r.error);
      return r.value.execute(request, callCtx);
    },
  };
  const planResult = await planConsumer.call({ goal: "部署原型服务" }, ctx2);
  if (planResult.ok) {
    log("response", `steps = ${JSON.stringify(planResult.value.steps)}`);
  } else {
    console.error("   调用失败:", planResult.error);
  }

  // 6. 协议适配演示：infrastructure（api-router）→ cognitive（LiteLLM）
  console.log("\n6. 协议适配演示：Anthropic Messages → 内部标准 → LiteLLM");
  const ctx3 = kernel.createContext("session-003", LayerId.Infrastructure);

  // 模拟 Claude Code（Anthropic Messages 协议）打进来的请求
  const anthropicReq: ProtocolAdapterRequest = {
    protocol: "anthropic-messages",
    headers: { "user-agent": "claude-cli/2.x", "x-app": "claude-code" },
    body: {
      model: "qwen-turbo",
      system: "你是简洁的中文助手",
      messages: [{ role: "user", content: "用一句话介绍你自己" }],
      max_tokens: 64,
    },
  };

  const adapterRef: CapabilityRef = {
    id: "@infrastructure/protocol-adapter",
    versionRange: "^1.0.0",
  };
  const adapterRes = await kernel.registry.resolve<ProtocolAdapterRequest, ProtocolAdapterResponse>(adapterRef);
  if (!adapterRes.ok) {
    console.error("   resolve protocol-adapter 失败:", adapterRes.error);
  } else {
    const execRes = await adapterRes.value.execute(anthropicReq, ctx3);
    if (!execRes.ok) {
      console.error("   协议适配调用失败:", execRes.error);
    } else if (execRes.value.protocol === "anthropic-messages") {
      const resp = execRes.value.response;
      for (const block of resp.content) {
        if (block.type === "text") log("anthropic", `text: ${block.text}`);
        else log("anthropic", `tool_use: ${block.name}(${JSON.stringify(block.input)})`);
      }
      log("anthropic", `stop_reason = ${resp.stop_reason}, usage = ${JSON.stringify(resp.usage)}`);
    }
  }

  // 7. 内化样板演示：action 层 TTS（Open-LLM-VTuber 内化的第一个能力）
  console.log("\n7. 内化样板演示：@action/text-to-speech（源自 Open-LLM-VTuber）");
  const ctx4 = kernel.createContext("session-004", LayerId.Orchestration);

  const ttsRef: CapabilityRef = {
    id: "@action/text-to-speech",
    versionRange: "^1.0.0",
  };
  const ttsRes = await kernel.registry.resolve<TextToSpeechRequest, TextToSpeechResponse>(ttsRef);
  if (!ttsRes.ok) {
    console.error("   resolve text-to-speech 失败:", ttsRes.error);
  } else {
    const ttsReq: TextToSpeechRequest = {
      text: "你好，这是内化进框架的文本转语音能力",
      voice: "zh-CN-XiaoxiaoNeural",
    };
    log("request", JSON.stringify(ttsReq));
    const ttsExec = await ttsRes.value.execute(ttsReq, ctx4);
    if (!ttsExec.ok) {
      console.error("   TTS 合成失败:", ttsExec.error);
    } else {
      log("response", `audioFilePath = ${ttsExec.value.audioFilePath}`);
      log("response", `voice = ${ttsExec.value.voice}`);
      if (ttsExec.value.metadataFilePath) {
        log("response", `metadataFilePath = ${ttsExec.value.metadataFilePath}`);
      }
    }
  }

  // 8. 编码代理演示：orchestration -> Codex CLI（外部编码代理内化为编排能力）
  console.log("\n8. 编码代理演示：@orchestration/codex-agent（驱动 Codex CLI）");
  const ctx5 = kernel.createContext("session-005", LayerId.Orchestration);

  const codexRef: CapabilityRef = {
    id: "@orchestration/codex-agent",
    versionRange: "^1.0.0",
  };
  const codexRes = await kernel.registry.resolve<CodexAgentRequest, CodexAgentResponse>(codexRef);
  if (!codexRes.ok) {
    console.error("   resolve codex-agent 失败:", codexRes.error);
  } else {
    const codexReq: CodexAgentRequest = {
      prompt: "Reply with exactly: ARCH_OK",
      cwd: process.cwd(),
      sandboxMode: "read-only",
      timeoutMs: 60_000,
    };
    log("request", `prompt = ${codexReq.prompt}`);
    const codexExec = await codexRes.value.execute(codexReq, ctx5);
    if (!codexExec.ok) {
      console.error("   codex-agent 执行失败:", codexExec.error);
    } else {
      log("response", `threadId = ${codexExec.value.threadId}`);
      log("response", `text = ${codexExec.value.text}`);
      log(
        "response",
        `items = ${codexExec.value.items.length}, hadMetadataFallback = ${codexExec.value.hadMetadataFallback}`,
      );
    }
  }

  // 9. 关闭
  console.log("\n9. 关闭...");
  const sd = await shutdown(kernel, scheduler);
  if (!sd.ok) {
    console.error("   关闭失败:", sd.error);
    process.exit(1);
  }
  console.log("   关闭成功，kernel.isReady =", kernel.isReady());
  console.log("\n=== 原型模式演示完成 ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
