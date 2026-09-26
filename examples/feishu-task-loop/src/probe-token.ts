/**
 * 探针：验证飞书 user token 能否用 refresh_token 自动续期（免扫码）。
 * 用法：pnpm --filter feishu-task-loop exec tsx src/probe-token.ts
 */
import { getFreshUserToken } from "@aigility-harness/layer-action";
import { loadEnv, REPO_ROOT } from "./env.js";
import { isAbsolute, resolve as resolvePath } from "node:path";

loadEnv();
const store = process.env["FEISHU_USER_TOKEN_STORE"];
if (store && !isAbsolute(store)) {
  process.env["FEISHU_USER_TOKEN_STORE"] = resolvePath(REPO_ROOT, store);
}
try {
  const token = await getFreshUserToken(
    {
      appId: process.env.FEISHU_APP_ID ?? "",
      appSecret: process.env.FEISHU_APP_SECRET ?? "",
      tokenStorePath: process.env.FEISHU_USER_TOKEN_STORE ?? "feishu/user_token.local.json",
    },
    "https://open.feishu.cn",
  );
  console.log(`✅ token 续期成功（len=${token.length}），store 已回写`);
} catch (e) {
  console.error("❌ 续期失败（需重新 OAuth 扫码）:", e instanceof Error ? e.message : e);
  process.exit(1);
}
