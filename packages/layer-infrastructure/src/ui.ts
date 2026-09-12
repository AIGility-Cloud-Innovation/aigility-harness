/**
 * L1 底座层: 最小 Web UI (单文件内嵌 HTML)
 *
 * 浏览器可访问的最小实现:
 *   - 单角色: 销售客服 (/api/chat)
 *   - 输入框 + 对话区, fetch 调 http-ingress 的 agent 链路
 *   - 零外部依赖 (无 CDN/框架), 内联 CSS/JS
 *
 * 由 http-ingress 在 GET / 和 GET /ui 时返回, 起服务即开箱可点。
 *
 * AppBase 引导: 装配方设置 APPBASE_URL 后, 标题栏右侧出现
 * 「注册 / 登录 AppBase」链接(嵌在 AppBase 登录页旁的原型演示卡片里, 引导游客注册)。
 */

/** AppBase 引导链接(装配未设置 APPBASE_URL 时不渲染, 保持其他装配方干净) */
const APPBASE_URL = process.env.APPBASE_URL ?? "";
const LOGIN_LINK = APPBASE_URL
  ? `<a href="${APPBASE_URL}" target="_blank" rel="noopener">注册 / 登录 AppBase →</a>`
  : "";

export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>aigility 原型演示</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1f2937; color: #fff; padding: 9px 14px; display: flex; align-items: center; }
  header h1 { font-size: 14px; font-weight: 600; flex: 1; }
  header a { font-size: 12px; color: #a5b4fc; font-weight: 600; text-decoration: none; }
  header a:hover { color: #c7d2fe; }
  #chat { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 80%; padding: 9px 13px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 2px; }
  .msg.agent { align-self: flex-start; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-bottom-left-radius: 2px; }
  .msg .name { display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px; }
  .msg.user .name { color: #bfdbfe; text-align: right; }
  .hint { text-align: center; color: #9ca3af; font-size: 13px; margin: auto; padding: 20px; }
  #inputBar { display: flex; gap: 8px; padding: 10px 14px; background: #fff; border-top: 1px solid #e5e7eb; }
  #input { flex: 1; padding: 9px 13px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; }
  #input:focus { border-color: #2563eb; }
  #sendBtn { padding: 9px 18px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  #sendBtn:disabled { background: #93c5fd; cursor: not-allowed; }
</style>
</head>
<body>
<header>
  <h1>🧪 aigility 原型演示</h1>
  ${LOGIN_LINK}
</header>
<div id="chat">
  <div class="hint">有问题直接问 👇</div>
</div>
<div id="inputBar">
  <input id="input" placeholder="输入消息，回车发送" autocomplete="off">
  <button id="sendBtn">发送</button>
</div>
<script>
  const ENDPOINT = "/api/chat";
  const ROLE_NAME = "销售客服";

  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");

  function addMsg(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "agent");
    el.innerHTML = '<span class="name">' + (role === "user" ? "我" : ROLE_NAME) + '</span>' + escapeHtml(text);
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    addMsg("user", text);
    input.value = "";
    sendBtn.disabled = true;
    try {
      const resp = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_input: text }),
      });
      const data = await resp.json();
      const reply = data.response || data.result || data.error || JSON.stringify(data);
      const extras = [];
      if (data.suggested_path) extras.push("推荐接入: " + data.suggested_path);
      if (data.available) extras.push("已扫描: " + data.available.length + " 项");
      addMsg("agent", reply + (extras.length ? "\\n\\n" + extras.join("\\n") : ""));
    } catch (e) {
      addMsg("agent", "请求失败: " + e.message);
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  input.focus();
</script>
</body>
</html>`;
