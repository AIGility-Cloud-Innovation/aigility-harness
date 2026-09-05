/**
 * L1 底座基础层: 多功能对话厅 (hall)
 *
 * 框架自带的基本前端功能——多角色对话界面, 带框架介绍/指引。
 * 是用户与框架交互的默认入口 (最早设计的产品形态)。
 *
 * 设计要点:
 *   - 提供 GET /hall (对话厅页面) + POST /hall/chat (多角色对话 API)
 *   - 角色可配置: 装配方传入 roles 映射 (路径→能力ID + 显示名 + 人设)
 *   - 内置默认四角色: codex-chat(创建者) / sales-chat / plugin-helper / coder
 *   - 零业务知识: hall 只做「把消息路由到对应角色」的纯传输, 角色知识在 persona 层
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
  type ServiceDefinition,
  type Provider,
  type SeamContext,
  type LayerPlugin,
  type PluginManifest,
  type Result,
  type HealthStatus,
  type CapabilityRef,
} from "@aigility-harness/core";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface HallRole {
  /** 能力 ID (如 @persona/codex-chat) */
  id: string;
  /** 显示名 (如 "Codex 助手") */
  name: string;
  /** 角色 emoji */
  emoji: string;
  /** 人设提示词 (可选, 不传用角色自身人设) */
  system?: string;
}

export interface HallRequest {
  /** 监听端口 (未注入 server 时使用) */
  port: number;
  /** 外部注入的 HTTP server (与后端 API 同端口, 同源) */
  server?: Server;
  /** 角色列表 (页面页签 + 路由映射) */
  roles?: HallRole[];
  /** 对话厅页面路径 (默认 /hall) */
  uiPath?: string;
  /** 对话 API 路径 (默认 /hall/chat) */
  chatPath?: string;
}

export interface HallResponse {
  started: boolean;
  port: number;
  uiPath: string;
  chatPath: string;
  roles: string[];
  /** 注入 server 模式时的 hall 路由 handler (装配方挂载到自己 server 上) */
  handler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export const hallService: ServiceDefinition<HallRequest, HallResponse> = {
  id: "@infrastructure/hall",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "多功能对话厅：框架自带基本前端，多角色对话入口",
};

// ── 默认角色 ─────────────────────────────────────────────────────

const DEFAULT_ROLES: HallRole[] = [
  { id: "@persona/codex-chat", name: "Codex 网页应用生成器", emoji: "🪶", system: "你是 Codex 网页应用生成器, 专注生成/修改网页应用。" },
  { id: "@persona/sales-chat", name: "销售客服", emoji: "💼", system: "你是销售客服, 热情专业解答产品咨询。" },
  { id: "@persona/plugin-helper", name: "插件助手", emoji: "🧩", system: "你是插件安装助手, 帮助用户了解插件安装。" },
  { id: "@persona/coder", name: "编码助手", emoji: "👨💻", system: "你是资深编码助手, 擅长写出高质量代码。" },
];

// ── Provider 实现 ────────────────────────────────────────────────

let server: Server | null = null;
let activeCtx: SeamContext | null = null;

const hallProvider: Provider<HallRequest, HallResponse> = {
  service: hallService,
  name: "infrastructure-hall",
  state: PluginState.Active,
  async execute(
    request: HallRequest,
    ctx: SeamContext,
  ): Promise<Result<HallResponse>> {
    activeCtx = ctx;
    const port = request.port;
    const uiPath = request.uiPath ?? "/hall";
    const chatPath = request.chatPath ?? "/hall/chat";
    const roles = request.roles && request.roles.length > 0 ? request.roles : DEFAULT_ROLES;

    // 角色映射: id → role
    const roleById = new Map(roles.map((r) => [r.id, r]));

    // 读对话厅页面 (内嵌在 provider)
    const hallHtml = getHallHtml(roles, chatPath);

    // hall 路由 handler (可被外部 server 复用, 同源)
    const hallHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;

      // GET /hall → 页面
      if (req.method === "GET" && path === uiPath) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(hallHtml);
        return;
      }

      // GET /hall/roles → 角色列表 (前端页签)
      if (req.method === "GET" && path === `${uiPath}/roles`) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(roles.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji }))));
        return;
      }

      // POST /hall/chat → 对话 (转给对应角色)
      if (req.method === "POST" && path === chatPath) {
        await handleChat(req, res, roles, roleById, ctx);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "hall: not found", hint: `${uiPath} ${chatPath}` }));
    };

    // 注入的外部 server → 由装配方负责挂载 hallHandler, 这里只存引用
    if (request.server) {
      server = request.server;
    } else {
      const hallServer = createServer(hallHandler);
      await new Promise<void>((resolve) => hallServer.listen(port, "0.0.0.0", () => resolve()));
      server = hallServer;
    }

    return ok({
      started: true,
      port,
      uiPath,
      chatPath,
      roles: roles.map((r) => r.id),
      ...(request.server ? { handler: hallHandler } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: server?.listening ?? false,
      detail: server?.listening ? "hall listening" : "hall not started",
      checkedAt: new Date().toISOString(),
    };
  },
};

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  roles: HallRole[],
  roleById: Map<string, HallRole>,
  ctx: SeamContext,
): Promise<void> {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // 读 body
  let body: any = {};
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  } catch { send(400, { error: "JSON 解析失败" }); return; }

  const roleId = String(body.role ?? roles[0]?.id ?? "");
  const message = String(body.message ?? "").trim();
  if (!message) { send(400, { error: "消息不能为空" }); return; }

  const role = roleById.get(roleId);
  if (!role) { send(404, { error: `未知角色: ${roleId}` }); return; }

  // 调对应角色能力 (persona 层), 带人设覆盖
  const payload = {
    user_input: message,
    ...(role.system ? { system: role.system } : {}),
  };
  try {
    const result = await ctx.call({ id: role.id, versionRange: "^1.0.0" }, payload);
    if (!result.ok) {
      send(500, { error: `角色 ${role.name} 调用失败: ${result.error}` });
      return;
    }
    const value = result.value as { response?: string; agent_name?: string };
    send(200, { response: value?.response ?? "（无回复）", agent_name: value?.agent_name ?? role.name, role: roleId });
  } catch (e: any) {
    send(500, { error: `对话失败: ${String(e?.message ?? e)}` });
  }
}

// 生成对话厅页面 (内嵌全部角色配置到页面, 前端动态渲染页签)
function getHallHtml(roles: HallRole[], chatPath: string): string {
  const rolesJson = JSON.stringify(roles.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji })));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>多功能对话厅 · Multi-Role Hall</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1e293b; padding: 14px 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #334155; }
  header h1 { font-size: 17px; font-weight: 600; color: #f8fafc; }
  header span { font-size: 12px; color: #94a3b8; }
  .tabs { display: flex; gap: 6px; padding: 12px 24px 0; flex-wrap: wrap; }
  .tab { padding: 9px 18px; border: 1px solid #334155; background: #1e293b; color: #94a3b8; border-radius: 10px 10px 0 0; cursor: pointer; font-size: 14px; transition: all .15s; }
  .tab:hover { color: #e2e8f0; }
  .tab.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
  .tab .emoji { margin-right: 6px; }
  #chat { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 78%; padding: 11px 16px; border-radius: 14px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 3px; }
  .msg.agent { align-self: flex-start; background: #1e293b; border: 1px solid #334155; border-bottom-left-radius: 3px; }
  .msg .name { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 5px; }
  .msg.user .name { color: #bfdbfe; text-align: right; }
  .hint { text-align: center; color: #64748b; font-size: 13px; margin: auto; padding: 30px; line-height: 1.8; }
  .typing { align-self: flex-start; background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 11px 16px; border-radius: 14px; font-size: 13px; }
  #inputBar { display: flex; gap: 10px; padding: 14px 24px; background: #1e293b; border-top: 1px solid #334155; }
  #input { flex: 1; padding: 11px 16px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; border-radius: 10px; font-size: 14px; outline: none; }
  #input:focus { border-color: #2563eb; }
  #sendBtn { padding: 11px 24px; background: #2563eb; color: #fff; border: none; border-radius: 10px; font-size: 14px; cursor: pointer; font-weight: 600; }
  #sendBtn:disabled { background: #1e40af; cursor: not-allowed; opacity: .6; }
  .meta { text-align: center; color: #64748b; font-size: 12px; padding: 8px; background: #0f172a; }
</style>
</head>
<body>
<header>
  <h1>🎭 多功能对话厅</h1>
  <span>多个 AI 角色，一个页面 · 由 aigility-harness 驱动</span>
</header>

<div class="tabs" id="tabs"></div>
<div id="chat">
  <div class="hint" id="hint">选择一个角色，开始对话。</div>
</div>
<div class="meta" id="meta"></div>

<div id="inputBar">
  <input id="input" placeholder="输入消息，回车发送" autocomplete="off">
  <button id="sendBtn">发送</button>
</div>

<script>
  const ROLES = ${rolesJson};
  let currentRole = ROLES[0] ? ROLES[0].id : null;
  let history = {};

  const tabs = document.getElementById("tabs");
  const chat = document.getElementById("chat");
  const meta = document.getElementById("meta");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const hint = document.getElementById("hint");

  // 渲染页签
  ROLES.forEach((r) => {
    const b = document.createElement("button");
    b.className = "tab" + (r.id === currentRole ? " active" : "");
    b.innerHTML = '<span class="emoji">' + r.emoji + '</span>' + r.name;
    b.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      b.classList.add("active");
      currentRole = r.id;
      meta.textContent = "当前角色: " + r.emoji + " " + r.name;
      input.placeholder = "和" + r.name + "对话...";
    };
    tabs.appendChild(b);
  });
  if (currentRole) {
    const r0 = ROLES[0];
    meta.textContent = "当前角色: " + r0.emoji + " " + r0.name;
    input.placeholder = "和" + r0.name + "对话...";
  }

  function addMsg(role, text, name) {
    const el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "agent");
    el.innerHTML = '<span class="name">' + (role === "user" ? "我" : (name || "AI")) + '</span>' + escapeHtml(text);
    chat.appendChild(el);
    if (hint) hint.style.display = "none";
    chat.scrollTop = chat.scrollHeight;
    return el;
  }
  function addTyping() {
    const el = document.createElement("div");
    el.className = "typing";
    el.textContent = "正在思考...";
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !currentRole) return;
    addMsg("user", text);
    input.value = "";
    sendBtn.disabled = true;
    const typing = addTyping();
    try {
      const resp = await fetch("${chatPath}", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: currentRole, message: text, history: history[currentRole] || [] }),
      });
      const data = await resp.json();
      typing.remove();
      if (!resp.ok) throw new Error(data.error || ("HTTP " + resp.status));
      const reply = data.response || "（无回复）";
      addMsg("agent", reply, data.agent_name);
      history[currentRole] = [...(history[currentRole] || []), { role: "user", content: text }, { role: "assistant", content: reply }];
      if (history[currentRole].length > 20) history[currentRole] = history[currentRole].slice(-20);
    } catch (e) {
      typing.remove();
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
}

export { hallProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@infrastructure/hall",
  layer: LayerId.Infrastructure,
  description: "底座：多功能对话厅（框架自带基本前端，多角色对话入口）",
  version: "0.1.0",
  provides: [hallService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Disposed;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [hallProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};