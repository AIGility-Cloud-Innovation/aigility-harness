/**
 * 配置外置共用件: 业务 YAML 配置加载 + {{占位符}} 渲染
 *
 * 目录约定: packages/layer-orchestration/config/<file.yaml>
 * (src/ 与 dist/ 同为包根下一级, 相对定位对两种运行形态一致)
 *
 * 加载语义 (配置化的底线): 文件缺失 / 顶层段缺失 / 解析失败 → 返回 null,
 * 由调用方回落到代码内置默认值 —— 配置坏了不炸服务, 只丢定制。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "..", "config");

/** 渲染 {{key}} 占位符; 未提供的键原样保留 (便于一眼发现配置缺漏) */
export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 读取 config/<filename> 的顶层段 <rootKey>; 不存在或解析失败返回 null */
export function loadConfigSection<T>(filename: string, rootKey: string): T | null {
  const p = resolve(CONFIG_DIR, filename);
  if (!existsSync(p)) return null;
  try {
    const raw = yaml.load(readFileSync(p, "utf-8")) as Record<string, T> | null;
    return (raw?.[rootKey] as T) ?? null;
  } catch (e) {
    console.error(`[config] ${filename} 解析失败:`, e);
    return null;
  }
}
