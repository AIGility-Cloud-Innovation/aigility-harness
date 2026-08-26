/**
 * 极简 .env 加载器 — 从仓库根目录 .env 读取配置
 * (避免引入 dotenv 依赖; 支持 KEY=VALUE 与 # 注释)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 仓库根 = examples/wecom-guide/src → ../../../../
const ROOT = resolve(__dirname, "../../../../");

export function loadEnv(path = resolve(ROOT, ".env")): void {
  if (!existsSync(path)) {
    console.warn(`[env] .env 不存在 (${path}), 依赖环境变量`);
    return;
  }
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}