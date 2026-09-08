/**
 * DSH (DeepSeek Harness / cordis) 插件宿主
 *
 * 在 AppBase 服务进程内懒创建一个 cordis Context (与 kernel-dsh 同一运行时),
 * 按 dsh_plugins 注册表把启用的 cordis 插件加载进来, 并记录每个插件的状态。
 *
 * 设计要点:
 *  - 懒创建: 第一次「加载」时才 new Context(), 不影响未使用 DSH 的启动路径
 *  - 停用单个插件 = 销毁宿主并重载其余启用的插件 (cordis 单插件卸载需要持有
 *    插件服务句柄, v1 用重建方式实现, 语义等价)
 *  - 插件包是 TS 源码入口也没关系: 服务器跑在 tsx 下, 动态 import 时即时编译
 */

type AnyCtx = {
  plugin: (p: unknown, cfg: unknown) => Promise<void> | void;
  destroy?: () => Promise<void> | void;
};

interface HostState {
  ctx: AnyCtx;
  startedAt: string;
  plugins: Map<string, { at: string; error?: string }>;
}

let host: HostState | null = null;

export interface DshPluginRecord {
  name: string;
  package: string;
  export_name: string;
  config: Record<string, unknown>;
}

export function dshStatus(): { hostAlive: boolean; startedAt?: string; plugins: Record<string, { at: string; error?: string }> } {
  if (!host) return { hostAlive: false, plugins: {} };
  return {
    hostAlive: true,
    startedAt: host.startedAt,
    plugins: Object.fromEntries(host.plugins),
  };
}

async function ensureHost(): Promise<AnyCtx> {
  if (host) return host.ctx;
  const cordis = await import("@deepseek-ai/cordis");
  const ctx = new cordis.Context() as unknown as AnyCtx;
  host = { ctx, startedAt: new Date().toISOString(), plugins: new Map() };
  return ctx;
}

/** 从包里挑出 cordis 插件: exportName > default > 首个函数导出 */
function pickPlugin(mod: Record<string, unknown>, exportName: string): unknown {
  if (exportName && mod[exportName] !== undefined) return mod[exportName];
  if (typeof mod.default === "function") return mod.default;
  for (const v of Object.values(mod)) {
    if (typeof v === "function") return v;
  }
  return undefined;
}

export async function dshLoadPlugin(rec: DshPluginRecord): Promise<{ ok: boolean; error?: string }> {
  const ctx = await ensureHost();
  try {
    const mod = (await import(/* tsx-ignore */ rec.package)) as Record<string, unknown>;
    const plugin = pickPlugin(mod, rec.export_name);
    if (!plugin) throw new Error(`包 ${rec.package} 中没有可加载的插件导出 (找了 ${rec.export_name || "default"} 与函数导出)`);
    await ctx.plugin(plugin, rec.config ?? {});
    host!.plugins.set(rec.name, { at: new Date().toISOString() });
    return { ok: true };
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    host?.plugins.set(rec.name, { at: new Date().toISOString(), error });
    return { ok: false, error };
  }
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
