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

import { DshInterop, dshSuiteVersions, dshAgentHeadless, parsePatchEntries } from "@aigility-harness/dsh-interop";
import type { DshHeadlessResult } from "@aigility-harness/dsh-interop";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

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

// ── Agent 通道 (headless) ─────────────────────────────────────────
// 官方 dsh headless profile 组装完整服务图 (llm/agent/tools/skill/会话/沙箱),
// LLM 上游经环境变量指向 OpenAI 兼容网关 (bigmodel)。这是应用消费 dsh
// agent 能力 (含 Skill) 的可靠通道; 进程内服务图组装属 M2 profile 组合器。

// 家目录固定在 examples/.dsh-home: 首次 headless 运行时官方已在 profiles/ 下
// 装好整套依赖树 (pnpm nodeLinker=hoisted), 复用避免重新装配。
// 注意层级: import.meta.url = src/dsh-host.ts, "..",".." 到 examples (不是 appbase)。
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_AGENT_HOME = join(APP_ROOT, ".dsh-home");

export async function dshAgentRun(task: string): Promise<DshHeadlessResult> {
  const apiKey = process.env.BIGMODEL_API_KEY ?? "";
  if (!apiKey) {
    return { ok: false, output: "", error: "未配置 BIGMODEL_API_KEY (启动环境)", durationMs: 0 };
  }
  mkdirSync(DSH_AGENT_HOME, { recursive: true });
  return dshAgentHeadless({
    task,
    dshHome: DSH_AGENT_HOME,
    apiKey,
    baseURL: process.env.DSH_LLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    model: process.env.DSH_LLM_MODEL ?? "glm-4-flash",
    timeoutMs: 180_000,
    // 只读权限: 冒烟通道不给写盘/执行审批面, 后续按需放宽
    env: { DSH_PERMISSION_MODE: "read-only" },
  });
}

// ── 可体验插件盘点 (headless profile 用户补丁层) ─────────────────
// 「DSH 插件体验官」弹窗的数据源: 只列出真正装进 headless profile 的插件,
// 页面注册表里的插件 (进程内宿主) 不在此列 —— 体验通道跑的是官方 headless。

export interface DshAgentPlugin {
  id?: string;
  name: string;
}

export function dshAgentPlugins(): DshAgentPlugin[] {
  const patchPath = join(DSH_AGENT_HOME, "profiles", "headless", "cordis.patch.yml");
  if (!existsSync(patchPath)) return [];
  const out: DshAgentPlugin[] = [];
  for (const op of parsePatchEntries(readFileSync(patchPath, "utf8"))) {
    const rows = Array.isArray(op.insert) ? op.insert : [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.name === "string" && r.name.length > 0) {
        out.push({
          id: typeof r.id === "string" ? r.id : undefined,
          name: r.name,
        });
      }
    }
  }
  return out;
}
