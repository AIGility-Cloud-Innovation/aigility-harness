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
} from "@aigility-arch/layer-orchestration";

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
        payload: { capability: "@cognitive/llm-inference", prompt: request.prompt },
        traceId: callCtx.traceId,
      });
      const resolveResult = await kernel.registry.resolve<LlmInferenceRequest, LlmInferenceResponse>(
        this.ref,
      );
      if (!resolveResult.ok) {
        return err(resolveResult.error);
      }
      const provider = resolveResult.value;
      log("seam", `解析到 Provider: ${provider.name}`);
      const execResult = await provider.execute(request, callCtx);
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
    prompt: "请规划一个三步任务",
    systemPrompt: "你是任务规划助手",
    maxTokens: 128,
  };
  log("request", JSON.stringify(llmRequest));

  const llmResult = await llmConsumer.call(llmRequest, ctx);
  if (!llmResult.ok) {
    console.error("   跨层调用失败:", llmResult.error);
    process.exit(1);
  }
  console.log("   跨层调用结果:");
  log("response", `text = ${llmResult.value.text}`);
  log("response", `model = ${llmResult.value.model}, tokens = ${llmResult.value.tokens}`);

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

  // 6. 关闭
  console.log("\n6. 关闭...");
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
