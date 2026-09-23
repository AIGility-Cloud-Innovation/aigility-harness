/** 冒烟：通过 feishuApiProvider 真实调用任务列表（读取 feishu/app.local.json 注入 env） */
import { readFileSync } from "node:fs";
import { feishuApiProvider } from "./src/feishu-api.js";

const cred = JSON.parse(readFileSync("../../feishu/app.local.json", "utf8"));
process.env.FEISHU_APP_ID = cred.app_id;
process.env.FEISHU_APP_SECRET = cred.app_secret;
process.env.FEISHU_USER_TOKEN_STORE = "../../feishu/user_token.local.json";

const ctx = { emit: () => {}, traceId: "smoke" } as never;

const health = await feishuApiProvider.health!();
console.log("health:", JSON.stringify(health, null, 2));

const r = await feishuApiProvider.execute(
  {
    method: "GET",
    path: "/open-apis/task/v2/tasks",
    query: { page_size: 3, user_id_type: "open_id" },
    identity: "user",
  },
  ctx,
);
if (!r.ok) {
  console.error("FAIL:", r.err);
  process.exit(1);
}
console.log("code:", r.value.code, "msg:", r.value.msg);
const items = (r.value.data as { items?: { summary: string }[] })?.items ?? [];
for (const t of items) console.log(" -", t.summary.trim().slice(0, 40));
process.exit(r.value.code === 0 ? 0 : 1);
