#!/usr/bin/env node
/**
 * persona-coach 官方 dsh headless 装载冒烟（M2③ 验收自动化）。
 *
 * 做三件事，全部幂等：
 *   1. 把本插件包以 file: 依赖装进 DSH home 的 headless profile
 *   2. 在 profile 用户补丁层 (cordis.patch.yml) 追加 persona-coach 插入行
 *   3. 用官方 dsh CLI headless 跑一次任务，输出 agent 回复
 *
 * 用法:
 *   pnpm --filter @aigility-harness/dsh-plugin-persona-coach run smoke -- "我想给班里做个记账本"
 * 环境变量:
 *   DSH_HOME        默认 <repo>/examples/.dsh-home
 *   DEEPSEEK_API_KEY  (必填) 上游密钥
 *   DEEPSEEK_BASE_URL 默认 https://open.bigmodel.cn/api/paas/v4
 *   DSH_LLM_MODEL   默认 glm-4-flash
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PLUGIN_DIR, "..", "..");
const task = process.argv[2] ?? "我想给班里做个记账本";
const dshHome = process.env.DSH_HOME ?? path.join(REPO_ROOT, "examples", ".dsh-home");
const profileDir = path.join(dshHome, "profiles", "headless");

if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`[coach-smoke] headless profile 不存在: ${profileDir} —— 先跑一次 dshAgentHeadless 让官方初始化`);
  process.exit(1);
}

// ── 1. 插件依赖 (file: 链接到本包 dist) ──────────────────────────
const profilePkgPath = join(profileDir, "package.json");
const profilePkg = JSON.parse(readFileSync(profilePkgPath, "utf8"));
const depSpec = `file:${PLUGIN_DIR}`;
const normalized = (s) => String(s).replaceAll("\\", "/");
if (normalized(profilePkg.dependencies?.["@aigility-harness/dsh-plugin-persona-coach"]) !== normalized(depSpec)) {
  const r = spawnSync("pnpm", ["add", "-w", depSpec], { cwd: profileDir, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("[coach-smoke] pnpm add 失败");
    process.exit(1);
  }
}

// ── 2. 用户补丁层插入行 ──────────────────────────────────────────
const patchPath = join(profileDir, "cordis.patch.yml");
const row = `- insert:\n    - id: persona-coach\n      name: '@aigility-harness/dsh-plugin-persona-coach'\n`;
const patchRaw = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
if (!patchRaw.includes("persona-coach")) {
  writeFileSync(patchPath, patchRaw + row, "utf8");
  console.log("[coach-smoke] 已追加 persona-coach 插入行到用户补丁层");
}

// ── 3. 官方 CLI headless 跑一次 ──────────────────────────────────
const profileRequire = createRequire(join(profileDir, "package.json"));
let binJs;
try {
  const dshPkgPath = profileRequire.resolve("@deepseek-ai/dsh/package.json");
  const dshPkg = JSON.parse(readFileSync(dshPkgPath, "utf8"));
  binJs = path.join(path.dirname(dshPkgPath), dshPkg.bin.dsh);
} catch {
  console.error("[coach-smoke] profile 内解析不到 @deepseek-ai/dsh —— headless profile 未装配完整");
  process.exit(1);
}

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("[coach-smoke] 缺 DEEPSEEK_API_KEY —— 无法真跑对话; 但依赖与补丁行已就绪");
  process.exit(2);
}

console.log(`[coach-smoke] task: ${task}`);
const r = spawnSync(
  process.execPath,
  [binJs, "--profile", "headless", task],
  {
    cwd: dshHome,
    stdio: "inherit",
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
      DSH_TELEMETRY_DISABLED: "1",
    },
  },
);
process.exit(r.status ?? 1);
