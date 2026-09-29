/**
 * HarnessInterop — 家族中立的能力底座互操作契约。
 *
 * 任何 harness 家族（当前 dsh，未来其他家族）以一个 interop 实现
 * （如 @aigility-harness/dsh-interop）接入本契约：上层与产品壳只认识
 * 此接口，harness 本身可替换——契约是主体，实现是过客。
 *
 * 职责边界：
 *   - 家族套件的依赖、版本锁定、与工程内核的实例对齐校验，全部收敛在
 *     家族 interop 实现内，不进纯内核包（kernel-* 保持零家族依赖）。
 *   - `mount` 的目标 substrate 由家族定义（dsh 家族即 cordis Context），
 *     实现负责校验类型；类型不符属编程错误，实现应抛 TypeError。
 */

/** 家族内一个可装载能力的描述（dsh 家族即 cordis.patch.yml 的一行）。 */
export interface CapabilityDescriptor {
  /** 装载点标识，用于日志/矩阵报告 */
  id?: string;
  /** 家族内的包/插件标识（dsh 家族为 npm 包名） */
  name: string;
  /** 指定具名导出（省略时由实现按家族约定探测） */
  exportName?: string;
  config?: Record<string, unknown>;
  disabled?: boolean;
}

export type CapabilityMountResult =
  | { status: "mounted"; id?: string; /** substrate 侧句柄 (dsh 家族即 cordis Fork), 供单能力卸载用 */ ref?: unknown }
  | { status: "skipped"; id?: string; reason: string }
  | { status: "failed"; id?: string; error: string };

export interface HarnessVersionInfo {
  /** harness 家族标识（"dsh" | 未来其他） */
  family: string;
  /** 家族套件锁定版本 */
  suite: string;
  /** 家族底层内核版本 */
  kernel: string;
  /** 家族内核与本工程内核是否解析到同一物理实例（单运行时保险丝） */
  aligned: boolean;
}

export interface HarnessInterop {
  readonly family: string;
  /** 版本与对齐状态；aligned === false 时必须先对齐再装载 */
  versions(): HarnessVersionInfo;
  /**
   * 把一个家族内能力挂到家族内核 substrate 上。能力缺失/包不可达等
   * 运行期问题返回 failed；substrate 类型不符抛 TypeError。
   *
   * opts.resolveFrom: 调用方模块标识（如 import.meta.url），供实现把
   * capability.name 在「调用方的解析环境」里定位——隔离布局
   * （pnpm）下调用方依赖对 interop 包不可见，必须由调用方提供基准。
   */
  mount(
    ctx: unknown,
    capability: CapabilityDescriptor,
    opts?: { resolveFrom?: string },
  ): Promise<CapabilityMountResult>;
}

// ── WorkflowRunner（家族中立编排能力契约） ────────────────────────────
//
// 大规模多代理编排（脚本 fan-out 子代理）的家族中立入口。dsh 家族由
// dsh-interop 的 dshWorkflowRun 实现（官方 dsh workflow 引擎）；上层与
// kernel-* 只认此接口，harness 本身可替换。

/** 编排脚本身份块（与模型侧 workflow 工具的 meta 参数同形）。 */
export interface WorkflowMeta {
  /** 短 kebab-case 工作流名 */
  name: string;
  /** 一句话描述 */
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string }>;
}

export interface WorkflowRunRequest {
  /** plain JavaScript 编排脚本（无 meta 导出；meta 单独传） */
  script: string;
  meta: WorkflowMeta;
  /** 暴露给脚本的 args 全局（裸列表请包一层字段） */
  args?: unknown;
}

export interface WorkflowRunOutcome {
  ok: boolean;
  /** 脚本最终 JSON 返回值；不可靠解析时缺省（原文在实现侧留存） */
  result?: unknown;
  /** 是否可靠提取到了 JSON 返回值 */
  parsed: boolean;
  error?: string;
  durationMs: number;
}

/** 运行期参数由家族实现定义（dsh 家族：dshHome/apiKey/baseURL/model…）。 */
export interface WorkflowRunRuntime {
  [key: string]: unknown;
}

export interface WorkflowRunner {
  runWorkflow(
    request: WorkflowRunRequest,
    runtime?: WorkflowRunRuntime,
  ): Promise<WorkflowRunOutcome>;
}
