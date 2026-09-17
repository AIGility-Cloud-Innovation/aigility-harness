/**
 * installedDshPackages — 盘点本机实际安装的官方 dsh 插件包。
 *
 * 数据源是官方元包 `@deepseek-ai/dsh` 的 dependencies（即官方套件全家福），
 * 逐包解析磁盘上的实际安装版本（pnpm 隔离布局下经元包的 require 链解析），
 * 并与 dsh-base 官方清单行按包名对齐——「安装了什么」与「清单声明什么」
 * 两个视角在此合流。
 */

import { createRequire } from "node:module";
import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { dshBaseRows, isJsExpr } from "./base-rows.js";

const localRequire = createRequire(import.meta.url);

export interface InstalledDshPackage {
  /** npm 包名（@deepseek-ai/dsh-tool-bash 等） */
  name: string;
  /** 磁盘上实际安装的版本 */
  version: string;
  description: string;
  /** 在官方 dsh-base 清单中出现的行 id（未出现在清单 = 套件支撑包，非插件） */
  officialRowIds: string[];
  /** true = 官方清单中的插件行；false = 套件支撑库（如 schemastery） */
  isPlugin: boolean;
}

interface PkgMeta {
  version: string;
  description: string;
  dirRealpath: string;
}

function readMeta(spec: string, require: NodeRequire): PkgMeta {
  // exports map 可能不放行 package.json 子路径 → 从入口向上找
  let pkgPath: string;
  try {
    pkgPath = require.resolve(`${spec}/package.json`);
  } catch {
    let dir = path.dirname(require.resolve(spec));
    pkgPath = path.join(dir, "package.json");
    while (!exists(pkgPath)) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error(`package.json not found for ${spec}`);
      dir = parent;
      pkgPath = path.join(dir, "package.json");
    }
  }
  const meta = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version?: string;
    description?: string;
  };
  return {
    version: meta.version ?? "?",
    description: meta.description ?? "",
    dirRealpath: realpathSync(pkgPath),
  };
}

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 盘点官方 dsh 套件在本机的实际安装情况：从元包 dependencies 出发，
 * 递归展开 @deepseek-ai/* 传递依赖（dsh-session 等能力包是 dsh-base 的
 * 传递依赖，只看元包直接依赖会漏）。同步、只读；元包未安装时抛错。
 */
export function installedDshPackages(): InstalledDshPackage[] {
  // 官方清单行按包名索引
  const rowsByName = new Map<string, Array<{ id?: string }>>();
  for (const row of dshBaseRows()) {
    const list = rowsByName.get(row.name) ?? [];
    list.push({ id: row.id });
    rowsByName.set(row.name, list);
  }

  const metaPkg = readMeta("@deepseek-ai/dsh", localRequire);
  const out = new Map<string, InstalledDshPackage>();
  const visited = new Set<string>(["@deepseek-ai/dsh"]);
  const queue: Array<{ name: string; require: NodeRequire }> = [];

  const enqueueDeps = (pkg: PkgMeta): void => {
    const { dependencies } = JSON.parse(
      readFileSync(path.join(path.dirname(pkg.dirRealpath), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const pkgRequire = createRequire(pkg.dirRealpath);
    for (const dep of Object.keys(dependencies ?? {})) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      // 只追官方 scope 的传递依赖（三方运行依赖如 commander 不属于套件盘点）
      if (!dep.startsWith("@deepseek-ai/")) continue;
      queue.push({ name: dep, require: pkgRequire });
    }
  };

  enqueueDeps(metaPkg);
  while (queue.length > 0) {
    const { name, require } = queue.shift()!;
    try {
      const pkg = readMeta(name, require);
      const rowIds = (rowsByName.get(name) ?? []).map((r) => r.id ?? "").filter(Boolean);
      out.set(name, {
        name,
        version: pkg.version,
        description: pkg.description,
        officialRowIds: rowIds,
        isPlugin: rowIds.length > 0,
      });
      enqueueDeps(pkg);
    } catch {
      // 依赖声明了但本机未装（异常布局）→ 跳过，不阻断盘点
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 供展示用的辅助：JsExpr → js(...) 原文（不在此处也保留 isJsExpr 再导出语义） */
export function disabledToText(disabled: unknown): string | null {
  if (isJsExpr(disabled)) return `js(${disabled.__jsExpr})`;
  if (disabled === true) return "默认禁用";
  return null;
}
