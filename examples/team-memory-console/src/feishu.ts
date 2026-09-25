/**
 * 飞书推送 — 自定义机器人应用 (tenant_access_token) 发群消息
 *
 * 凭证: FEISHU_APP_ID / FEISHU_APP_SECRET (仓库根 .env, 项目小助手应用)
 * 目标: FEISHU_REPORT_CHAT_ID (群 chat_id, 默认 "TiMEM-AI全员群")
 */

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

export const DEFAULT_REPORT_CHAT_ID = "oc_4cb8ba33aa96ae5c40a24267c0188cf1"; // TiMEM-AI全员群

let cachedToken: { token: string; expireAt: number } | null = null;

async function tenantAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;
  const appId = process.env.FEISHU_APP_ID ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? "";
  if (!appId || !appSecret) throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  const resp = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = (await resp.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
  if (json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: code=${json.code} ${json.msg ?? ""}`);
  }
  cachedToken = { token: json.tenant_access_token, expireAt: Date.now() + ((json.expire ?? 7200) - 300) * 1000 };
  return cachedToken.token;
}

/** 发送文本到群 (chat_id); msgType=text 最稳妥, markdown 用 interactive 卡片太重 */
export async function sendGroupText(chatId: string, text: string): Promise<void> {
  const token = await tenantAccessToken();
  const resp = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }),
  });
  const json = (await resp.json()) as { code: number; msg?: string };
  if (json.code !== 0) throw new Error(`飞书发消息失败: code=${json.code} ${json.msg ?? ""}`);
}

/** 长文本自动分段 (飞书单条 text 上限 ~150KB, 实践按 3500 字切, 保住可读性) */
export async function sendGroupTextChunked(chatId: string, text: string, chunkSize = 3500): Promise<number> {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf("\n", chunkSize);
    if (cut < chunkSize * 0.5) cut = chunkSize;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const c of chunks) await sendGroupText(chatId, c);
  return chunks.length;
}
