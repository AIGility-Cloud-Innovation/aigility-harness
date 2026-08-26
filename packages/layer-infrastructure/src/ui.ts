/**
 * L5 底座层: 最小 Web UI (单文件内嵌 HTML)
 *
 * 浏览器可访问的最小实现:
 *   - 两个页签: 销售客服 (/api/chat) 与 插件安装助手 (/api/plugin-helper)
 *   - 输入框 + 对话区, fetch 调 http-ingress 的 agent 链路
 *   - 零外部依赖 (无 CDN/框架), 内联 CSS/JS
 *
 * 由 http-ingress 在 GET / 和 GET /ui 时返回, 起服务即开箱可点。
 */

export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>aigility-harness · 最小 UI</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1f2937; color: #fff; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; font-weight: 600; }
  header span { font-size: 12px; color: #9ca3af; }
  .tabs { display: flex; gap: 4px; padding: 10px 20px 0; }
  .tab { padding: 8px 16px; border: none; background: #e5e7eb; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 14px; color: #4b5563; }
  .tab.active { background: #fff; color: #111827; font-weight: 600; }
  #chat { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 2px; }
  .msg.agent { align-self: flex-start; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-bottom-left-radius: 2px; }
  .msg .name { display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px; }
  .msg.user .name { color: #bfdbfe; text-align: right; }
  .hint { text-align: center; color: #9ca3af; font-size: 12px; margin: auto; padding: 20px; }
  #inputBar { display: flex; gap: 10px; padding: 12px 20px; background: #fff; border-top: 1px solid #e5e7eb; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; }
  #input:focus { border-color: #2563eb; }
  #sendBtn { padding: 10px 20px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
  #sendBtn:disabled { background: #93c5fd; cursor: not-allowed; }
  .meta { text-align: center; color: #6b7280; font-size: 12px; padding: 6px; background: #f9fafb; }
</style>
</head>
<body>
<header>
  <h1>aigility-harness</h1>
  <span>最小可执行 Agent · 浏览器直连</span>
</header>
<div class="tabs">
  <button class="tab active" data-role="sales">销售客服</button>
  <button class="tab" data-role="helper">插件安装助手</button>
</div>
<div id="chat">
  <div class="hint">选择一个角色，输入消息开始对话。<br>销售客服走 /api/chat · 插件安装助手走 /api/plugin-helper</div>
</div>
<div class="meta" id="meta"></div>
<div id="inputBar">
  <input id="input" placeholder="输入消息，回车发送" autocomplete="off">
  <button id="sendBtn">发送</button>
</div>
<script>
  const ROLE_ENDPOINT = { sales: "/api/chat", helper: "/api/plugin-helper" };
  const ROLE_NAME = { sales: "销售客服", helper: "插件安装助手" };
  let currentRole = "sales";

  const chat = document.getElementById("chat");
  const meta = document.getElementById("meta");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentRole = tab.dataset.role;
      meta.textContent = "当前调用: POST " + ROLE_ENDPOINT[currentRole];
    });
  });
  meta.textContent = "当前调用: POST " + ROLE_ENDPOINT[currentRole];

  function addMsg(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "agent");
    el.innerHTML = '<span class="name">' + (role === "user" ? "我" : ROLE_NAME[currentRole]) + '</span>' + escapeHtml(text);
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
      const resp = await fetch(ROLE_ENDPOINT[currentRole], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_input: text }),
      });
      const data = await resp.json();
      const reply = data.response || data.result || data.error || JSON.stringify(data);
      const extras = [];
      if (data.suggested_path) extras.push("推荐接入: " + data.suggested_path);
      if (data.available) extras.push("已扫描: " + data.available.length + " 项");
      addMsg("agent", reply + (extras.length ? "\n\n" + extras.join("\n") : ""));
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