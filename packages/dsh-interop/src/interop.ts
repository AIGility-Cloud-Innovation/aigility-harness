/**
 * DshInterop — dsh harness 家族的 HarnessInterop 契约实现。
 *
 * 本包是官方 @deepseek-ai/dsh 套件在本工程的唯一落脚点：家族套件依赖、
 * 精确锁版本、与工程内核的实例对齐校验、按行装载，全部收敛在这里。
 * 上层通过 core 的 `HarnessInterop` 家族中立接口消费本实现——将来更换
 * harness 家族，等价于提供一个同契约的新 interop 包，上层无感。
 *
 * 技术依据（拆包实测）：dsh 全部能力都是普通 cordis 插件，以
 * cordis.patch.yml 行清单 ({id, name, config, disabled}) 编址；官方
 * profile 组合器做 yml 解析 + !!js 求值 + 覆盖合并——那是信任边界内的
 * 官方职责，本实现只消费行对象（组合器属 M2 规划，见
 * docs/dsh-生态共建规划.md）。
 */

import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type {
  CapabilityDescriptor,
  CapabilityMountResult,
  HarnessInterop,
  HarnessVersionInfo,
} from "@aigility-harness/core";

const localRequire = createRequire(import.meta.url);

export interface DshSuiteVersions {
  /** 元包/CLI（bin: dsh） */
  dsh: string;
  /** profile 打包件（cordis.patch.yml 载体，无运行时 API） */
  dshBase: string;
  /** 共享内核的解析版本 */
  cordis: string;
  /** 本包与 dsh-base 是否解析到同一个 cordis 物理模块 */
  cordisAligned: boolean;
}

interface PkgInfo {
  version: string;
  /** realpath 后的包入口文件，用于跨树实例比对 */
  entryRealpath: string;
}

function readPkg(spec: string, require = localRequire): PkgInfo {
  // 优先走 `spec/package.json` 子路径；exports map 未放行时从入口向上找
  let pkgPath: string;
  try {
    pkgPath = require.resolve(`${spec}/package.json`);
  } catch {
    let dir = path.dirname(require.resolve(spec));
    pkgPath = path.join(dir, "package.json");
    while (!existsPkg(pkgPath)) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`找不到 ${spec} 的 package.json`);
      dir = parent;
      pkgPath = path.join(dir, "package.json");
    }
  }
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version: string;
  };
  return { version, entryRealpath: realpathSync(pkgPath) };
}

function existsPkg(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析官方 dsh 套件的锁定版本，并校验两侧（本包 vs dsh-base 依赖树）的
 * cordis 是否为同一物理模块。`cordisAligned: false` 意味着运行时被分裂成
 * 两套 Context 体系——那是接入层最深的故障态，必须在对齐前拒绝装载。
 */
export function dshSuiteVersions(): DshSuiteVersions {
  const dsh = readPkg("@deepseek-ai/dsh");
  const dshBase = readPkg("@deepseek-ai/dsh-base");
  const cordisOurs = readPkg("@deepseek-ai/cordis");
  const cordisTheirs = readPkg(
    "@deepseek-ai/cordis",
    createRequire(dshBase.entryRealpath),
  );
  return {
    dsh: dsh.version,
    dshBase: dshBase.version,
    cordis: cordisOurs.version,
    cordisAligned: cordisOurs.entryRealpath === cordisTheirs.entryRealpath,
  };
}

/** 从包模块里挑出 cordis 插件：exportName > default > apply(整模块) > 首个函数 */
export function pickPluginExport(
  mod: Record<string, unknown>,
  exportName?: string,
): unknown {
  if (exportName && mod[exportName] !== undefined) return mod[exportName];
  if (typeof mod.default === "function") return mod.default;
  // 模块自带 apply + name 时传整模块，保留 cordis 的 name/inject 语义
  if (typeof mod.apply === "function") return mod;
  for (const v of Object.values(mod)) {
    if (typeof v === "function") return v;
  }
  return undefined;
}

function assertCordisContext(ctx: unknown): asserts ctx is Context {
  if (
    typeof ctx !== "object" ||
    ctx === null ||
    typeof (ctx as { plugin?: unknown }).plugin !== "function"
  ) {
    throw new TypeError(
      "DshInterop.mount 需要 cordis Context 作为 substrate (缺 plugin 方法)",
    );
  }
}

/**
 * 把一行官方风格的插件行装载到 Context 上。
 *
 * 包定位按三级解析基准依次尝试（隔离布局下互不可见，必须多基准）：
 *   1. opts.resolveFrom —— 调用方模块标识（appbase 装的第三方插件如 @timem/*）
 *   2. 官方套件链（dsh-base 的解析环境）—— 官方传递依赖（dsh-tool-* 等）
 *   3. interop 自身 —— 兜底
 * 命中后按物理入口文件 pathToFileURL import，绕开包名解析限制。
 */
export async function mountDshRow(
  ctx: Context,
  row: CapabilityDescriptor,
  opts?: { resolveFrom?: string },
): Promise<CapabilityMountResult> {
  if (row.disabled) {
    return { status: "skipped", id: row.id, reason: "disabled" };
  }
  try {
    const mod = await resolvePluginModule(row.name, opts);
    const plugin = pickPluginExport(mod, row.exportName);
    if (!plugin) {
      throw new Error(
        `包 ${row.name} 中没有可装载的插件导出 (找了 ${row.exportName || "default"} / apply / 函数导出)`,
      );
    }
    // 保留 cordis 返回的 Fork 句柄: 调用方可据此单插件卸载 (dispose), 无需销毁整个 Context
    const fork = await (ctx as unknown as {
      plugin: (p: unknown, cfg: unknown) => Promise<unknown> | unknown;
    }).plugin(plugin, row.config ?? {});
    return { status: "mounted", id: row.id, ref: fork };
  } catch (e) {
    return {
      status: "failed",
      id: row.id,
      error: String((e as Error)?.message ?? e),
    };
  }
}

/** 官方套件解析环境（dsh-base 的 require 链，可达整个 .pnpm 内部树） */
let _suiteRequire: NodeRequire | null = null;
function suiteRequire(): NodeRequire {
  if (!_suiteRequire) {
    _suiteRequire = createRequire(
      localRequire.resolve("@deepseek-ai/dsh-base/package.json"),
    );
  }
  return _suiteRequire;
}

/**
 * 按三级解析基准定位并 import 一个插件包模块（mountDshRow 与组合器共用）：
 *   1. resolveFrom —— 调用方模块标识（隔离布局下互不可见，必须多基准）
 *   2. 官方套件链（dsh-base 的解析环境）—— 官方传递依赖（dsh-tool-* 等）
 *   3. interop 自身 —— 兜底
 * 命中后按物理入口文件 pathToFileURL import，绕开包名解析限制。
 */
export async function resolvePluginModule(
  name: string,
  opts?: { resolveFrom?: string },
): Promise<Record<string, unknown>> {
  const bases: NodeRequire[] = [];
  if (opts?.resolveFrom) bases.push(createRequire(opts.resolveFrom));
  bases.push(suiteRequire(), localRequire);
  let entry: string | null = null;
  for (const req of bases) {
    try {
      entry = pathToFileURL(req.resolve(name)).href;
      break;
    } catch {
      /* 下一个基准 */
    }
  }
  return (entry ? await import(entry) : await import(name)) as Record<
    string,
    unknown
  >;
}

/**
 * HarnessInterop 契约的 dsh 家族实现。
 *
 *   family   = "dsh"
 *   versions = dshSuiteVersions()（套件版本 + cordisAligned 保险丝）
 *   mount    = mountDshRow()（substrate 必须是 cordis Context）
 */
export class DshInterop implements HarnessInterop {
  readonly family = "dsh";

  versions(): HarnessVersionInfo {
    const v = dshSuiteVersions();
    return {
      family: this.family,
      suite: v.dsh,
      kernel: v.cordis,
      aligned: v.cordisAligned,
    };
  }

  async mount(
    ctx: unknown,
    capability: CapabilityDescriptor,
    opts?: { resolveFrom?: string },
  ): Promise<CapabilityMountResult> {
    assertCordisContext(ctx);
    return mountDshRow(ctx, capability, opts);
  }
}
