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
  | { status: "mounted"; id?: string }
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
   */
  mount(
    ctx: unknown,
    capability: CapabilityDescriptor,
  ): Promise<CapabilityMountResult>;
}
