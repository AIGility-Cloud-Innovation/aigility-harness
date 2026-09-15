/**
 * DSH (DeepSeek Harness / cordis) 插件宿主
 *
 * 在 AppBase 服务进程内懒创建一个 cordis Context (与 kernel-dsh 同一运行时),
 * 按 dsh_plugins 注册表把启用的 cordis 插件加载进来, 并记录每个插件的状态。
 *
 * 装载统一走 @aigility-harness/dsh-interop (官方套件在本工程的唯一落脚点):
 * 行装载 / 导出探测 / cordis 实例对齐校验都在 interop 内, 宿主只负责
 * 进程内 Context 的生命周期与状态记录。
 *
 * 设计要点:
 *  - 懒创建: 第一次「加载」时才 new Context(), 不影响未使用 DSH 的启动路径
 *  - 停用单个插件 = 销毁宿主并重载其余启用的插件 (cordis 单插件卸载需要持有
 *    插件服务句柄, v1 用重建方式实现, 语义等价)
 *  - 插件包是 TS 源码入口也没关系: 服务器跑在 tsx 下, 动态 import 时即时编译
 */

import { DshInterop, dshSuiteVersions } from "@aigility-harness/dsh-interop";

type AnyCtx = {
  plugin: (p: unknown, cfg: unknown) => Promise<void> | void;
  destroy?: () => Promise<void> | void;
};

interface HostState {
  ctx: AnyCtx;
  startedAt: string;
  versions: ReturnType<typeof dshSuiteVersions>;
  plugins: Map<string, { at: string; error?: string }>;
}

const interop = new DshInterop();
let host: HostState | null = null;

export interface DshPluginRecord {
  name: string;
  package: string;
  export_name: string;
  config: Record<string, unknown>;
}

export function dshStatus(): {
  hostAlive: boolean;
  startedAt?: string;
  versions?: ReturnType<typeof dshSuiteVersions>;
  plugins: Record<string, { at: string; error?: string }>;
} {
  if (!host) return { hostAlive: false, plugins: {} };
  return {
    hostAlive: true,
    startedAt: host.startedAt,
    versions: host.versions,
    plugins: Object.fromEntries(host.plugins),
  };
}

async function ensureHost(): Promise<AnyCtx> {
  if (host) return host.ctx;
  const cordis = await import("@deepseek-ai/cordis");
  const ctx = new cordis.Context() as unknown as AnyCtx;
  const versions = dshSuiteVersions();
  if (!versions.cordisAligned) {
    // 保险丝: 双运行时分裂是最深的故障态, 带病装载行为不可预测
    console.warn("[dsh-host] ⚠ cordis 实例不对齐 (cordisAligned=false), 装载行为可能不可预测");
  }
  host = { ctx, startedAt: new Date().toISOString(), versions, plugins: new Map() };
  return ctx;
}

export async function dshLoadPlugin(rec: DshPluginRecord): Promise<{ ok: boolean; error?: string }> {
  const ctx = await ensureHost();
  // resolveFrom = 本模块: 让 appbase 的依赖 (如 @timem/*) 在调用方解析环境定位
  const r = await interop.mount(ctx as unknown, {
    id: rec.name,
    name: rec.package,
    exportName: rec.export_name || undefined,
    config: rec.config ?? {},
  }, { resolveFrom: import.meta.url });
  if (r.status === "mounted") {
    host!.plugins.set(rec.name, { at: new Date().toISOString() });
    return { ok: true };
  }
  const error = r.status === "failed" ? r.error : "skipped (disabled)";
  host?.plugins.set(rec.name, { at: new Date().toISOString(), error });
  return { ok: false, error };
}

/** 销毁整个宿主 (停用单个插件后由调用方重载其余启用的插件) */
export async function dshDestroyHost(): Promise<void> {
  if (!host) return;
  try {
    await host.ctx.destroy?.();
  } catch { /* 尽力而为 */ }
  host = null;
}

/** 加载全部启用的插件 (宿主重建/首次拉起用); 返回逐个结果 */
export async function dshLoadEnabled(records: DshPluginRecord[]): Promise<Record<string, { ok: boolean; error?: string }>> {
  await dshDestroyHost();
  const out: Record<string, { ok: boolean; error?: string }> = {};
  for (const rec of records) {
    out[rec.name] = await dshLoadPlugin(rec);
  }
  return out;
}
