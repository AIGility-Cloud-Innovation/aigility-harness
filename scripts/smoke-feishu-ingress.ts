/**
 * feishu-ingress 真实冒烟：用真凭据连接飞书 WS 长连接。
 * 用法: FEISHU_APP_ID=... FEISHU_APP_SECRET=... npx tsx scripts/smoke-feishu-ingress.ts
 */
import { feishuIngressProvider } from "../packages/layer-infrastructure/src/feishu-ingress.js";

// 最小 SeamContext：消息直接回显（真实验证连接+收消息，不依赖人格装配）
const ctx = {
  async call(ref: { id: string }, req: unknown) {
    console.log("[smoke] route to:", ref.id, "input:", JSON.stringify(req).slice(0, 200));
    return { ok: true as const, value: { response: "冒烟回复：已收到你的消息 ✅" } };
  },
};

async function main() {
  const appId = process.env.FEISHU_APP_ID ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? "";
  if (!appId || !appSecret) {
    console.error("需要 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }
  console.log("[smoke] connecting appId =", appId);
  const result = await feishuIngressProvider.execute({ appId, appSecret }, ctx as never);
  console.log("[smoke] execute result:", JSON.stringify(result).slice(0, 300));
  if (!result.ok) {
    process.exit(1);
  }
  console.log("[smoke] 已连接，等待飞书消息（60s 超时）…发条消息测试");
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  await result.value.stop();
  console.log("[smoke] done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(1);
});