#!/usr/bin/env node
/**
 * 打印官方 @deepseek-ai/dsh CLI 的 bin.js 绝对路径。
 *
 * 供 start-dsh-web.cmd 等 .cmd 脚本用 node 直跑 CLI（绕开 pnpm.cmd shim
 * 在 .cmd 调用链里丢环境变量的问题，见 start-appbase.cmd 内注释）。
 * 锚定本包解析：@deepseek-ai/dsh 是 dsh-interop 的精确锁定依赖。
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const localRequire = createRequire(import.meta.url);
const pkgPath = localRequire.resolve("@deepseek-ai/dsh/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const rel = pkg.bin && pkg.bin.dsh;
if (!rel) {
  console.error("@deepseek-ai/dsh 未声明 bin.dsh");
  process.exit(1);
}
console.log(path.join(path.dirname(pkgPath), rel));
