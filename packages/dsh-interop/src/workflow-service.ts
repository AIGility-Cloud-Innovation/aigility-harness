/**
 * dshWorkflowRun 的 seam 服务化 + WorkflowRunner 契约适配。
 *
 * 这是「装配线」的一半：把 dsh-interop 里能跑通的 dshWorkflowRun 包装成
 * 两种上层可认的形态——
 *   1. `dshWorkflowRunService` / `createDshWorkflowRunProvider`：
 *      seam 服务（@harness/workflow-run），上层经 ctx.call 调用，
 *      与 @cognitive/llm-inference、@infrastructure/dsh-session-relay 同一形制；
 *   2. `createDshWorkflowRunner`：core 的家族中立 `WorkflowRunner` 接口，
 *      供 DshKernelAdapter（kernel-dsh）以构造注入方式持有。
 *
 * kernel-dsh 与各 layer 只认契约，不 import 本包——本包是唯一的家族落点。
 */

import { err, ok, LayerId, PluginState } from "@aigility-harness/core";
import type {
  CapabilityRef,
  HealthStatus,
  Provider,
  Result,
  ServiceDefinition,
  WorkflowMeta,
  WorkflowRunOutcome,
  WorkflowRunRequest,
  WorkflowRunner,
  WorkflowRunRuntime,
} from "@aigility-harness/core";
import { dshWorkflowRun } from "./workflow-run.js";
import type { DshWorkflowRunOptions } from "./workflow-run.js";

// ── 装配配置（运行期参数；env 可作缺省） ─────────────────────────

export interface DshWorkflowServiceOptions {
  /** DSH 家目录（脚本存档/补丁层落盘处）；缺省读 DSH_HOME */
  dshHome?: string;
  /** 上游 API 密钥；缺省读 DEEPSEEK_API_KEY */
  apiKey?: string;
  /** OpenAI 兼容端点；缺省读 DEEPSEEK_BASE_URL */
  baseURL?: string;
  /** 覆盖 headless profile 默认模型 */
  model?: string;
  /** 整体超时（缺省 600s，同 dshWorkflowRun） */
  timeoutMs?: number;
  /** 额外注入子进程的环境变量 */
  env?: Record<string, string>;
}

/** 从装配配置 + 环境变量解析最终运行参数，返回缺配置项清单。 */
export function resolveWorkflowRuntime(
  opts: DshWorkflowServiceOptions,
): { missing: string[]; runtime: DshWorkflowRunOptions } {
  const missing: string[] = [];
  const dshHome = opts.dshHome ?? process.env.DSH_HOME;
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseUrlResolved = opts.baseURL ?? process.env.DEEPSEEK_BASE_URL;
  if (!dshHome) missing.push("DSH_HOME");
  if (!apiKey) missing.push("DEEPSEEK_API_KEY");
  if (!baseUrlResolved) missing.push("DEEPSEEK_BASE_URL");
  return {
    missing,
    runtime: {
      dshHome: dshHome ?? "",
      apiKey: apiKey ?? "",
      baseURL: baseUrlResolved ?? "",
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    },
  };
}

// ── WorkflowRunner 契约适配（core 接口 → dshWorkflowRun） ─────────

/** 家族中立 WorkflowRunner 的 dsh 实现。runtime 参数可逐次覆盖 model/timeoutMs。 */
export function createDshWorkflowRunner(
  opts: DshWorkflowServiceOptions,
): WorkflowRunner {
  return {
    async runWorkflow(
      request: WorkflowRunRequest,
      runtime?: WorkflowRunRuntime,
    ): Promise<WorkflowRunOutcome> {
      const { missing, runtime: base } = resolveWorkflowRuntime(opts);
      if (missing.length > 0) {
        return {
          ok: false,
          parsed: false,
          error: `缺少配置: ${missing.join(", ")}`,
          durationMs: 0,
        };
      }
      const override = (runtime ?? {}) as Partial<DshWorkflowRunOptions>;
      const result = await dshWorkflowRun({
        ...base,
        ...override,
        script: request.script,
        meta: request.meta as DshWorkflowRunOptions["meta"],
        args: request.args,
      });
      return {
        ok: result.ok,
        result: result.result,
        parsed: result.parsed,
        error: result.error,
        durationMs: result.durationMs,
      };
    },
  };
}

// ── seam 服务定义 + Provider 工厂（同 session-relay 形制） ────────

export const dshWorkflowRunRef: CapabilityRef = {
  id: "@harness/workflow-run",
  versionRange: "^1.0.0",
};

export const dshWorkflowRunService: ServiceDefinition<
  WorkflowRunRequest,
  WorkflowRunOutcome
> = {
  id: "@harness/workflow-run",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "大规模多代理编排：经官方 dsh workflow 引擎执行 plain-JS 编排脚本（fan-out 子代理），返回 JSON 结果",
};

/** 装配编排 Provider（内核装配层注册到 kernel 即可；配置从装配参数/env 取）。 */
export function createDshWorkflowRunProvider(
  opts: DshWorkflowServiceOptions,
): Provider<WorkflowRunRequest, WorkflowRunOutcome> {
  const { missing, runtime } = resolveWorkflowRuntime(opts);
  const configured = missing.length === 0;
  const runner = createDshWorkflowRunner(opts);
  return {
    service: dshWorkflowRunService,
    name: "harness-dsh-workflow-run",
    state: PluginState.Active,
    async health(): Promise<HealthStatus> {
      return {
        healthy: configured,
        detail: configured
          ? `dshHome=${runtime.dshHome}`
          : `缺少配置: ${missing.join(", ")}`,
        checkedAt: new Date().toISOString(),
      };
    },
    execute(
      request: WorkflowRunRequest,
      _ctx: unknown,
    ): Promise<Result<WorkflowRunOutcome>> {
      if (!configured) {
        return Promise.resolve(err(`缺少配置: ${missing.join(", ")}`));
      }
      return runner
        .runWorkflow(request)
        .then((outcome) => (outcome.ok ? ok(outcome) : err(outcome.error ?? "workflow 运行失败")));
    },
  };
}

export type { WorkflowMeta, WorkflowRunRequest, WorkflowRunOutcome };
