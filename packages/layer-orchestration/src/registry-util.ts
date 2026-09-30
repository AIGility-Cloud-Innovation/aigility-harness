/**
 * 登记表共用工具 — 仓库 config/ 下登记表文件的定位与 mtime 缓存
 *
 * 背景：身份/项目两张登记表由智悦平台「身份对齐」页在线编辑写回，
 * 运行中的项目小助理进程必须不重启就能读到新配置——统一用
 * 「每次访问 statSync 比对 mtime，变了就重读」的策略（statSync 开销可忽略）。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 从 startDir 逐级向上找 `<dir>/config/<name>`（最多 8 级），找不到返回 undefined */
export function findRepoConfigFile(name: string, startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "config", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** mtime 缓存条目：路径 + 加载时的 mtime + 解析结果 */
export interface MtimeCacheEntry<T> {
  path: string;
  mtimeMs: number;
  file: T;
}

/**
 * 带自动重载的 JSON 登记表读取器。
 * 文件不存在时返回 fallback（由调用方提供空结构），路径/内容变化时自动重读。
 */
export function createRegistryReader<T>(name: string, fallback: () => T) {
  let cache: MtimeCacheEntry<T> | null = null;

  return function read(pathOverride?: string): T {
    const path = pathOverride ?? findRepoConfigFile(name);
    if (!path) return fallback();
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return fallback();
    }
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.file;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as T;
      cache = { path, mtimeMs, file };
      return file;
    } catch (e) {
      // 坏 JSON：保留旧缓存，控制台告警（平台写回是 tmp+rename 原子替换，正常不会读到半截）
      if (cache && cache.path === path) return cache.file;
      console.error(`[registry] ${name} 解析失败: ${String(e)}`);
      return fallback();
    }
  };
}
