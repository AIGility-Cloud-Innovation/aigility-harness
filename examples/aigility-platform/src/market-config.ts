/**
 * 智悦平台 · 智能体市场数据模式（站点级配置）
 *
 * 市场是面向普通用户的应用货架，展示内容由管理员控制：
 *   - mock（缺省）：管理员未设置时只显示演示模板（模拟数据），不暴露工厂/引擎内部能力；
 *   - real：货架展示工厂发布且可见范围=企业内 的数字员工（选企业内可见 = 上架市场）。
 *
 * 落盘到 data/market-config.json，与 site-tweaks / skill-registry 同款文件存储模式。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MarketDataMode = "mock" | "real";

export interface MarketConfig {
  dataMode: MarketDataMode;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "../data/market-config.json");

let cache: MarketConfig | null = null;

function loadFromDisk(): MarketConfig {
  try {
    if (!existsSync(DATA_FILE)) return { dataMode: "mock" };
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Partial<MarketConfig>;
    return { dataMode: raw.dataMode === "real" ? "real" : "mock" };
  } catch {
    return { dataMode: "mock" };
  }
}

function persist(config: MarketConfig): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function getMarketConfig(): MarketConfig {
  if (!cache) cache = loadFromDisk();
  return cache;
}

export function setMarketDataMode(dataMode: MarketDataMode): MarketConfig {
  cache = { ...getMarketConfig(), dataMode };
  persist(cache);
  return cache;
}
