/** 授权引导：用户身份 OAuth 首次授权（合并替代已退役的 feishu/oauth-*.ps1 与 feishu.mjs auth）。
 *
 * 用法（任意目录均可）：
 *   npx tsx packages/layer-action/authorize-feishu.ts                 # 自动：起本地回调服务 + 开浏览器
 *   npx tsx packages/layer-action/authorize-feishu.ts manual          # 手动：只打印授权链接
 *   npx tsx packages/layer-action/authorize-feishu.ts "<回调完整URL或code>"
 *
 * 凭证：FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量优先，否则读 <仓库根>/feishu/app.local.json；
 * token 落盘 FEISHU_USER_TOKEN_STORE，默认 <仓库根>/feishu/user_token.local.json（整个 feishu/ 已 gitignore）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REDIRECT_URI,
  buildAuthorizeUrl,
  exchangeAuthCode,
  extractAuthCode,
  readTokenEnv,
} from "./src/feishu-api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadCredentials(): { appId: string; appSecret: string } {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET };
  }
  const cred = JSON.parse(
    readFileSync(resolve(repoRoot, "feishu/app.local.json"), "utf8"),
  ) as { app_id: string; app_secret: string };
  return { appId: cred.app_id, appSecret: cred.app_secret };
}

const { appId, appSecret } = loadCredentials();
if (!appId || !appSecret) {
  console.error("缺少凭证：请设置 FEISHU_APP_ID/SECRET 或提供 feishu/app.local.json");
  process.exit(1);
}
const env = {
  ...readTokenEnv(),
  appId,
  appSecret,
  tokenStorePath:
    process.env.FEISHU_USER_TOKEN_STORE ?? resolve(repoRoot, "feishu/user_token.local.json"),
};

async function finish(code: string): Promise<void> {
  const rec = await exchangeAuthCode(env, code);
  console.log(`✅ 授权完成\n  scope: ${rec.scope ?? "(未返回)"}\n  token 已保存: ${env.tokenStorePath}`);
}

const arg = process.argv[2];

// ── 模式三：手动喂回调 URL / 裸 code ─────────────────────────────
if (arg && arg !== "manual") {
  const code = extractAuthCode(arg);
  if (!code) {
    console.error(`无法从输入中提取 code: "${arg.slice(0, 120)}"`);
    process.exit(1);
  }
  await finish(code);
  process.exit(0);
}

const auth = buildAuthorizeUrl({ appId });
console.log("授权链接（浏览器打开并同意授权）：\n" + auth.url);

// ── 模式二：manual —— 只打印链接，跳转后复制完整 URL 再按模式三执行 ──
if (arg === "manual") {
  console.log(
    `\n同意授权后浏览器会跳到 ${DEFAULT_REDIRECT_URI}?code=...（显示无法访问属正常），` +
      `\n把地址栏完整 URL 复制下来执行：\n  npx tsx packages/layer-action/authorize-feishu.ts "<完整URL>"`,
  );
  process.exit(0);
}

// ── 模式一：自动 —— 本地回调服务接 code，校验 state，自动换取 ─────
const port = Number(new URL(DEFAULT_REDIRECT_URI).port) || 80;
let server: ReturnType<typeof createServer>;
try {
  server = createServer();
  await new Promise<void>((res, rej) =>
    server.once("error", rej).listen(port, "127.0.0.1", res),
  );
} catch {
  console.error(`端口 ${port} 被占用，改用手动模式：npx tsx packages/layer-action/authorize-feishu.ts manual`);
  process.exit(1);
}

let timer: NodeJS.Timeout | undefined;
const waitCode = new Promise<string>((resolveCode) => {
  timer = setTimeout(
    () => resolveCode(""),
    5 * 60_000,
  );
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const code = u.searchParams.get("code");
    const okPage = code !== null && u.searchParams.get("state") === auth.state;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      okPage
        ? "<h2>✅ 授权成功，请回到终端</h2>"
        : "<h2>⚠️ 回调缺少 code 或 state 不匹配，请回到终端查看</h2>",
    );
    if (okPage) resolveCode(code);
  });
});
waitCode.then(
  () => {},
  () => {},
);
waitCode.finally(() => {
  if (timer) clearTimeout(timer);
  server.close();
});

console.log(`本地回调服务已就绪：${DEFAULT_REDIRECT_URI}（等待授权，最长 5 分钟）`);
exec(`start "" "${auth.url}"`);
try {
  const code = await waitCode;
  if (!code) {
    console.error("❌ 等待授权回调超时（5 分钟），可重跑或改用手动模式：manual");
    process.exitCode = 1;
  } else {
    await finish(code);
  }
} catch (e) {
  console.error("❌", (e as Error).message);
  process.exitCode = 1;
}
