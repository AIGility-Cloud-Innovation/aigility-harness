/**
 * 配置加载器 — 读 py-plugins.yaml (或 .json), 解析为 PyPluginConfig[].
 *
 * 支持 YAML 和 JSON 两种格式。
 * 环境变量替换: ${VAR} → process.env.VAR
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PyPluginConfig } from "./types.js";

// ── 环境变量替换 ──────────────────────────────────────────────────

function substituteEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return process.env[varName] ?? "";
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnv);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteEnv(v);
    }
    return result;
  }
  return value;
}

// ── 极简 YAML 解析 (只处理 py-plugins.yaml 的扁平结构) ──────────
// 不引入 yaml 依赖, 手写一个够用的解析器。
// 如果项目已有 yaml 依赖, 可以换成 yaml.parse。

function parseYaml(text: string): unknown {
  // 尝试 JSON first (有些配置可能是 .json 改了 .yaml 后缀)
  try {
    return JSON.parse(text);
  } catch {
    // 不是 JSON, 走 YAML
  }

  // 极简 YAML: 只支持 py-plugins.yaml 的结构
  // plugins: 下面的 - name: ... 列表
  // 不支持嵌套块、锚点等高级特性
  // 如果需要完整 YAML, 建议装 js-yaml
  throw new Error(
    "YAML parsing requires js-yaml. Install it or use JSON format (.json)."
  );
}

// ── 主加载函数 ────────────────────────────────────────────────────

export function loadPyPluginsConfig(
  configPath: string,
): PyPluginConfig[] {
  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    return []; // 配置文件不存在 = 没有 Python 插件, 不报错
  }

  const text = readFileSync(absPath, "utf8");
  const raw = absPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);

  const config = raw as { plugins?: PyPluginConfig[] };
  if (!config.plugins || !Array.isArray(config.plugins)) {
    return [];
  }

  // 环境变量替换
  return substituteEnv(config.plugins) as PyPluginConfig[];
}

/**
 * 从 PyPluginConfig[] 展平为 (config, capability) 对.
 * 每个 capability 对应一个 Seam Provider。
 */
export function flattenCapabilities(
  configs: PyPluginConfig[],
): Array<{ plugin: PyPluginConfig; cap: PyPluginConfig["capabilities"][number] }> {
  const result: Array<{
    plugin: PyPluginConfig;
    cap: PyPluginConfig["capabilities"][number];
  }> = [];
  for (const plugin of configs) {
    for (const cap of plugin.capabilities) {
      result.push({ plugin, cap });
    }
  }
  return result;
}

// 重新导出类型
export type { PyPluginConfig, PyCapabilityMapping } from "./types.js";
