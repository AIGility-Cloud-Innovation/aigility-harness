/**
 * Aigility 智悦智能平台（英文名 Aigility, 中文名「智悦」）—— FDE 自用的数字员工智能体平台
 * （examples/aigility-platform; 引擎为 aigility-harness, 全链路走五域 Seam）
 *
 * 一个进程两个端口（与 fde-workbench 同构）：
 *   - Web  :1236  静态前端（app/dist）+ 封装 API + AppBase 平台底座（/app/* 鉴权/数据/计量）
 *                 + 对话同源代理（/api/aigility/chat 等, 校验 AppBase 会话后转发网关, SSE 透传）
 *   - 网关 :1237  http-ingress（Bearer 鉴权）：OpenAI 兼容 dev 链路 + 数字员工 agent 链路
 *                 （主密钥仅服务端持有, 不注入前端页面 —— 浏览器对话一律走同源会话代理）
 *
 * 登录鉴权：复用 AppBase 平台账号（users 表 scrypt + HMAC token + 登录限流, 账号与 AppBase 互通）
 *   - 登录/注册/会话: POST /app/auth/login|register|logout · GET /app/auth/me（appBackendHandler 内置）
 *   - 本地 /api/aigility/* 全部校验 AppBase 会话（bearerUser）
 *
 * 深度整合链路（五域全走 Seam, 无业务旁路）：
 *   数字员工对话  POST /api/aigility-chat → @persona/aigility-agent
 *                 （payload.skill_id 命中智能体工厂发布的技能 → 按技能装配人设 + 记忆隔离）
 *                 → @orchestration/workflow-engine → @cognitive/llm-inference
 *                 （payload.stream=true 时网关编码为 OpenAI 兼容 SSE 逐字流式）
 *   引擎原生角色  POST /api/aigility/p/<key>/chat → @persona/<key>
 *                 （市场页「已接入」智能体直接对话 layer-persona 注册的真实角色）
 *
 * 定位：aigility-harness 是引擎，Aigility 是把它封装成「数字员工智能体平台」交付给客户的壳。
 * 市场页 persona 清单来自引擎注册表（真），智能体工厂发布真注册（真），
 * 能力总线/模型上游/TiMEM 记忆/运行指标为真接口，其余页面（数据接入/图谱/租户/计费…）维持产品壳演示（Mock）。
 */

import "./defaults.js";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LayerId,
  RunMode,
  bootstrap,
  InProcessScheduler,
} from "@aigility-harness/core";
import type { KernelConfig } from "@aigility-harness/core";

import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { plugin as infrastructurePlugin, stopHttpServer } from "@aigility-harness/layer-infrastructure";
import { plugin as cognitivePlugin } from "@aigility-harness/layer-cognitive";
import { plugin as personaPlugin } from "@aigility-harness/layer-persona";
import { plugin as orchestrationPlugin } from "@aigility-harness/layer-orchestration";
import { plugin as actionPlugin } from "@aigility-harness/layer-action";
import { isKnownGatewayKey, writeAudit } from "@aigility-harness/appbase/backend";
import { ensureAigilityPlatform, routePlatform, sessionUserId, listTeamMembers, recentAudit, emailById,
  createTask, listTasks, transitionTask, getTask, type TaskRow } from "./platform.js";
import { aigilityAgentPlugin } from "./aigility-agent.js";
import { dshToolBridgePlugin } from "./dsh-tool.js";
import { listSkills, upsertSkill, removeSkill, usageSnapshot, type AigilitySkillInput } from "./skill-registry.js";
import type { DshToolBridgeResponse } from "./dsh-tool.js";
import { planTask, WORKFLOW_DIR } from "./planner.js";
import { existsSync as fileExists } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.AIGILITY_WEB_PORT ?? 1236);
const GATEWAY_PORT = Number(process.env.AIGILITY_GATEWAY_PORT ?? 1237);
const DIST_DIR = resolve(__dirname, "../app/dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

// ── 引擎原生角色 → 市场页展示元数据（description 取自 ServiceDefinition） ──

const PERSONA_META: Record<string, { name: string; cat: string }> = {
  "@persona/fde-assistant": { name: "FDE 交付助手", cat: "办公效率" },
  "@persona/harness-guide": { name: "框架介绍员", cat: "知识服务" },
  "@persona/sales-chat": { name: "销售客服", cat: "客户服务" },
  "@persona/repair-chat": { name: "应用报修客服", cat: "客户服务" },
  "@persona/coding-coach": { name: "编码教练", cat: "办公效率" },
  "@persona/advisory-chat": { name: "就业数据顾问", cat: "数据分析" },
  "@persona/timem-support": { name: "TiMEM Space 客服", cat: "客户服务" },
  "@persona/timem-project-assistant": { name: "项目任务助手", cat: "流程辅助" },
  "@persona/lesson-prep-chat": { name: "备课助理", cat: "办公效率" },
  "@persona/plugin-helper": { name: "插件安装助手", cat: "知识服务" },
  "@persona/app-dev": { name: "网页应用开发员", cat: "内容生成" },
};

interface PersonaEntry {
  personaId: string;
  route: string;
  name: string;
  cat: string;
  desc: string;
  source: "harness";
}

/** 从 layer-persona 注册表枚举可对话的真实角色（市场页「已接入」区） */
function enumeratePersonas(): PersonaEntry[] {
  const out: PersonaEntry[] = [];
  for (const p of personaPlugin.getProviders()) {
    const id = p.service.id;
    const meta = PERSONA_META[id];
    if (!meta) continue;
    out.push({
      personaId: id,
      route: `/api/aigility/p/${id.replace("@persona/", "")}/chat`,
      name: meta.name,
      cat: meta.cat,
      desc: p.service.description,
      source: "harness",
    });
  }
  return out;
}

// ── HTTP 小工具 ──────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** 会话保护：/api/aigility/* 全部要求 AppBase 登录会话 */
function requireUser(req: IncomingMessage, res: ServerResponse): string | null {
  const userId = sessionUserId(req);
  if (!userId) {
    json(res, 401, { error: "未登录或会话已过期" });
    return null;
  }
  return userId;
}

// ── 主装配 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Aigility 智悦智能平台（FDE 自用 · 数字员工智能体平台）===\n");

  // 0. 平台底座（复用 AppBase app-backend）：PG schema + 演示账号/应用/网关 key 种子
  //    必须在内核 bootstrap 前（timem 插件 env 桥先于认知层生效）
  const platform = await ensureAigilityPlatform();
  // 用量收集共享密钥（网关 → /app/usage/collect 上报头）
  process.env.APPBASE_GATEWAY_KEY ??= randomBytes(24).toString("hex");

  // 1. 内核（原型模式, 内存实现）
  const kernel = new InMemoryKernelAdapter();

  // 2. 装配五域插件 + 智悦本地数字员工插件（aigility-agent 随示例自带, 不改框架包）
  const plugins = [
    infrastructurePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
    actionPlugin,
    aigilityAgentPlugin,
    dshToolBridgePlugin,
  ];
  console.log("装配插件:");
  for (const p of plugins) {
    console.log(`  - ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  // 3. bootstrap
  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "default",
    autoHotSwap: true,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const boot = await bootstrap({ kernel, kernelConfig, plugins, scheduler });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exitCode = 1;
    return;
  }
  console.log(`bootstrap 成功 (kernel.isReady=${kernel.isReady()})`);

  // 4. AI 网关（http-ingress, :1237）：aigility-agent + 引擎原生角色逐个开路由
  //    key 来自 app_keys 表（持久, 与 AppBase 共体系）; 用量上报 llm_usage
  const personas = enumeratePersonas();
  const gatewayKey = platform.gatewayKey;

  /** 会话代理：浏览器 → 同源（AppBase 会话已校验）→ 网关（Bearer 主密钥）→ SSE 透传。
   *  主密钥只在服务端进程内使用, 永不下发浏览器；客户端提前断开时中止上游请求。
   *  断连判定用 res 'close' + writableEnded（req 'close' 在请求体读完时同样触发, 不能用）。 */
  const proxyAgent = async (req: IncomingMessage, res: ServerResponse, upstreamPath: string): Promise<void> => {
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${upstreamPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayKey}` },
        body: await readBody(req),
        signal: abort.signal,
      });
    } catch (err) {
      json(res, 502, { error: `网关不可达: ${String(err)}` });
      return;
    }
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // 上游中断：SSE 已流出的帧不受影响, 尽力收尾
    } finally {
      res.end();
    }
  };

  const agentRoutes: Record<string, string> = {
    "/api/aigility-chat": "@persona/aigility-agent",
  };
  for (const p of personas) agentRoutes[p.route] = p.personaId;

  const gwCtx = kernel.createContext("aigility-gateway", LayerId.Infrastructure);
  const gwResolved = await kernel.registry.resolve({
    id: "@infrastructure/http-ingress",
    versionRange: "^1.0.0",
  });
  if (!gwResolved.ok) {
    console.error("resolve http-ingress 失败:", gwResolved.error);
    process.exitCode = 1;
    return;
  }
  const gwStart = await gwResolved.value.execute(
    {
      port: GATEWAY_PORT,
      bearerToken: gatewayKey,
      tokenVerifier: isKnownGatewayKey,
      usageReportUrl: `http://127.0.0.1:${WEB_PORT}/app/usage/collect`,
      devPaths: ["/v1/chat/completions", "/v1/messages"],
      agentPaths: ["/api/aigility-chat", ...personas.map((p) => p.route)],
      agentRoutes,
      ...(process.env.BIGMODEL_API_KEY
        ? {
            modelsUpstream: {
              url: process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
              key: process.env.BIGMODEL_API_KEY,
            },
          }
        : {}),
    },
    gwCtx,
  );
  if (!gwStart.ok) {
    console.error("网关启动失败:", gwStart.error);
    process.exitCode = 1;
    return;
  }

  // 5. Web 服务（:1236）：/app/* 平台 API（鉴权/数据/计量）+ 封装 API + 对话代理 + 静态
  const startedAt = Date.now();
  /** Web 侧 Seam 调用（外部入口走 D1 上下文, 与网关同模式） */
  const seamCall = async <T = { ok: boolean; total?: number; results?: Array<{ content: string; score?: number; memory_id?: string }>; error?: string }>(
    serviceId: string,
    request: unknown,
  ): Promise<{ ok: boolean; value?: T; error?: unknown }> => {
    const ctx = kernel.createContext("aigility-api", LayerId.Infrastructure);
    const resolved = await kernel.registry.resolve({ id: serviceId, versionRange: "^1.0.0" });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return (await resolved.value.execute(request, ctx)) as { ok: boolean; value?: T; error?: unknown };
  };

  // ── 执行器路由（content/docx）：workflow-engine 产出 → review 人在回路 ──
  const TASK_EXECUTOR_PROMPT = [
    "你是 Aigility 任务执行器。根据任务标题与说明产出高质量结果。",
    "- 产出正文用中文；如需结构化，用 Markdown（'# ' 小标题 / '- ' 要点）。",
    "- 只依据任务说明与你的知识产出, 不虚构数据; 说明不充分时给出合理假设并列明。",
  ].join("\n");

  const parseBlocks = (text: string) => {
    const blocks: Array<Record<string, unknown>> = [];
    let bullets: string[] = [];
    const flush = () => { if (bullets.length) { blocks.push({ type: "bullets", items: bullets }); bullets = []; } };
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) { flush(); continue; }
      if (line.startsWith("- ")) { bullets.push(line.slice(2)); continue; }
      flush();
      if (line.startsWith("# ")) blocks.push({ type: "heading", text: line.slice(2), level: 2 });
      else blocks.push({ type: "paragraph", text: line });
    }
    flush();
    return blocks;
  };

  const dispatchExecutorTask = (task: TaskRow): void => {
    if (task.executor === "workflow") return void dispatchWorkflowPlanner(task);
    void (async () => {
      try {
        await transitionTask(task.id, "open", "running");
        const wf = await seamCall<{ result?: string; response?: string }>("@orchestration/workflow-engine", {
          user_input: `【任务】${task.title}\n${task.detail ?? ""}`,
          system_prompt: TASK_EXECUTOR_PROMPT,
          agent_name: "Aigility 任务执行器",
          user_key: task.createdBy,
        });
        const text = (wf.ok ? (wf.value?.result ?? wf.value?.response) : null) ?? "";
        if (!wf.ok || !text.trim()) throw new Error(wf.ok ? "执行器无产出" : String(wf.error ?? "workflow-engine 调用失败"));
        if (task.executor === "docx") {
          const doc = await seamCall<{ filename?: string; base64?: string; bytes?: number; error?: string }>("@action/doc-worker", {
            title: task.title, subtitle: `执行器产出 · ${task.createdBy}`, blocks: parseBlocks(text),
          });
          if (!doc.ok || !doc.value?.base64) throw new Error(doc.value?.error ?? "doc-worker 生成失败");
          await transitionTask(task.id, "running", "review", {
            kind: "file", text, filename: doc.value.filename, base64: doc.value.base64, bytes: doc.value.bytes,
          });
        } else {
          await transitionTask(task.id, "running", "review", { kind: "text", text });
        }
        console.log(`[task] 执行器完成「${task.title}」→ review`);
      } catch (err) {
        await transitionTask(task.id, "running", "failed", { kind: "error", text: String(err) });
        console.error(`[task] 执行器失败「${task.title}」:`, err);
      }
    })();
  };

  // ── workflow 执行器 · Plan 段：LLM 拆解 → YAML 落盘 → review 人审 ──
  const dispatchWorkflowPlanner = (task: TaskRow): void => {
    void (async () => {
      try {
        await transitionTask(task.id, "open", "running");
        const plan = await planTask(task.id, task.title, task.detail, async (messages) => {
          const r = await seamCall<{ text?: string }>("@cognitive/llm-inference", {
            model: process.env.LLM_MODEL ?? "qwen2.5:7b",
            messages,
            temperature: 0,
          });
          if (!r.ok) throw new Error(String(r.error ?? "llm-inference 调用失败"));
          return r.value?.text ?? "";
        });
        await transitionTask(task.id, "running", "review", {
          kind: "workflow", yaml: plan.yamlText, yamlPath: plan.yamlPath,
          items: plan.items.map((i) => i.taskTitle), designDoc: plan.designDoc,
        });
        console.log(`[task] 拆解完成「${task.title}」(${plan.items.length} 个子任务) → review`);
      } catch (err) {
        await transitionTask(task.id, "running", "failed", { kind: "error", text: `拆解失败：${String(err)}` });
        console.error(`[task] 拆解失败「${task.title}」:`, err);
      }
    })();
  };

  // ── workflow 执行器 · Do 段：人审批准 → py-bridge 执行 YAML ──
  const executeWorkflowYaml = (task: TaskRow): void => {
    void (async () => {
      const result = (task.result ?? {}) as { yamlPath?: string };
      const yamlPath = result.yamlPath ?? resolve(WORKFLOW_DIR, `${task.id}.yaml`);
      try {
        if (!fileExists(yamlPath)) throw new Error(`工作流文件缺失: ${yamlPath}`);
        const r = await seamCall<Record<string, unknown>>("@orchestration/workflow-runtime", {
          config_path: yamlPath,
          user_input: `【任务】${task.title}\n${task.detail ?? ""}`,
        });
        // 注意：seamCall 失败是值形式（{ok:false,error}），不抛异常 —— 必须显式检查
        if (!r.ok) throw new Error(String(r.error ?? "workflow-runtime 调用失败"));
        const state = r.value ?? {};
        const text = String((state as { result?: unknown }).result ?? JSON.stringify(state).slice(0, 2000));
        await transitionTask(task.id, "running", "done", { kind: "text", text });
        console.log(`[task] 工作流执行完成「${task.title}」`);
      } catch (err) {
        const msg = String(err);
        const hint = msg.includes("resolve 失败") || msg.includes("Failed to resolve") || msg.includes("workflow-runtime")
          ? `${msg}（等待 aigility SDK runtime.py 落地后，在 config/py-plugins.json 声明 @orchestration/workflow-runtime 即通，见 README）`
          : msg;
        await transitionTask(task.id, "running", "failed", { kind: "error", text: hint });
        console.error(`[task] 工作流执行失败「${task.title}」:`, err);
      }
    })();
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 平台 API 优先（AppBase app-backend：/app/auth/* /app/data/* /app/usage/* …）
    if (await routePlatform(req, res)) return;

    const path = (req.url ?? "/").split("?")[0];

    // ── 封装 API（/api/aigility/*, 全部要求 AppBase 登录会话）──
    if (path.startsWith("/api/aigility/")) {
      if (!requireUser(req, res)) return;

      // 对话代理（同源会话 → 网关 agent 链路, SSE 透传）：主密钥仅服务端持有
      if (path === "/api/aigility/chat" && req.method === "POST") {
        await proxyAgent(req, res, "/api/aigility-chat");
        return;
      }
      const personaChat = path.match(/^\/api\/aigility\/p\/([\w-]+)\/chat$/);
      if (personaChat && req.method === "POST") {
        await proxyAgent(req, res, `/api/aigility/p/${personaChat[1]}/chat`);
        return;
      }

      if (path === "/api/aigility/registry" && req.method === "GET") {
        json(res, 200, {
          personas,
          skills: listSkills(),
          llm: process.env.LLM_PROVIDER ?? "stub",
        });
        return;
      }
      if (path === "/api/aigility/skills" && req.method === "GET") {
        json(res, 200, { skills: listSkills() });
        return;
      }
      if (path === "/api/aigility/skills" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as Partial<AigilitySkillInput>;
          if (!body.name?.trim() || !body.prompt?.trim() || !body.description?.trim()) {
            json(res, 400, { error: "发布至少需要名称、能力描述与角色 Prompt" });
            return;
          }
          const skill = upsertSkill({
            id: body.id?.trim() || `zy-${Date.now().toString(36)}`,
            name: body.name.trim(),
            category: body.category?.trim() || "知识服务",
            description: body.description.trim(),
            tags: Array.isArray(body.tags) ? body.tags : [],
            modelId: body.modelId?.trim() || "kimi-k3",
            prompt: body.prompt.trim(),
            temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
            knowledge: Array.isArray(body.knowledge) ? body.knowledge : [],
            tools: Array.isArray(body.tools) ? body.tools : [],
            visibility: body.visibility?.trim() || "企业内",
            releaseNote: body.releaseNote?.trim() || "",
          });
          console.log(`[工厂] 数字员工「${skill.name}」已发布 (id=${skill.id}) → @persona/aigility-agent 可按 skill_id 对话`);
          json(res, 200, { skill });
        } catch (err) {
          json(res, 400, { error: String(err) });
        }
        return;
      }
      const delMatch = path.match(/^\/api\/aigility\/skills\/([\w-]+)$/);
      if (delMatch && req.method === "DELETE") {
        json(res, 200, { ok: removeSkill(delMatch[1]) });
        return;
      }
      if (path === "/api/aigility/capabilities" && req.method === "GET") {
        // 引擎能力总线（真）：枚举内核已装配插件的全部 Provider
        const layerNames: Record<string, string> = {
          infrastructure: "D1 底座基础层",
          cognitive: "D2 认知算力层",
          action: "D3 行动执行层",
          orchestration: "D4 编排规划层",
          persona: "D5 角色人格层",
        };
        const capabilities = plugins.flatMap((p) =>
          p.getProviders().map((prov) => ({
            id: prov.service.id,
            layer: String(prov.service.layer),
            layerName: layerNames[String(prov.service.layer)] ?? String(prov.service.layer),
            description: prov.service.description,
          })),
        );
        json(res, 200, { capabilities });
        return;
      }
      if (path === "/api/aigility/llm" && req.method === "GET") {
        json(res, 200, {
          provider: process.env.LLM_PROVIDER ?? "stub",
          model: process.env.LLM_MODEL ?? "glm-4.6",
          baseUrl: process.env.BIGMODEL_BASE_URL ?? (process.env.LITELLM_URL || ""),
          degraded: (process.env.LLM_PROVIDER ?? "stub") === "stub",
        });
        return;
      }
      if (path === "/api/aigility/metrics" && req.method === "GET") {
        const skills = listSkills();
        json(res, 200, {
          uptimeMs: Date.now() - startedAt,
          personas: personas.length,
          skills: skills.length,
          skillUsage: Object.fromEntries(skills.map((s) => [s.id, usageSnapshot()[s.id] ?? 0])),
          butlerChats: usageSnapshot()["butler"] ?? 0,
          llm: process.env.LLM_PROVIDER ?? "stub",
        });
        return;
      }
      if (path === "/api/aigility/timem/status" && req.method === "GET") {
        const configured = Boolean(process.env.TIMEM_API_KEY);
        if (!configured) {
          json(res, 200, { configured: false, ok: false, baseUrl: process.env.TIMEM_BASE_URL ?? "" });
          return;
        }
        try {
          const t0 = Date.now();
          const probe = await seamCall("@action/timem-memory", { query: "ping", limit: 1 });
          if (!probe.ok || probe.value?.ok === false) throw new Error(String(probe.error ?? probe.value?.error ?? "TiMEM 不可达"));
          json(res, 200, { configured: true, ok: true, baseUrl: process.env.TIMEM_BASE_URL ?? "https://api.timem.cloud", latencyMs: Date.now() - t0 });
        } catch (err) {
          json(res, 200, { configured: true, ok: false, baseUrl: process.env.TIMEM_BASE_URL ?? "", error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/dsh/tools" && req.method === "GET") {
        // DSH ctx.tools 工具清单（真）：dsh-mcp-client 注册的 MCP 工具经桥枚举
        const r = await seamCall<DshToolBridgeResponse>("@action/dsh-tool", { action: "list" });
        json(res, 200, r.ok ? r.value : { ok: false, error: String(r.error ?? "桥调用失败") });
        return;
      }
      if (path === "/api/aigility/dsh/tools/call" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; args?: Record<string, unknown> };
        if (!body.name?.trim()) {
          json(res, 400, { ok: false, error: "name 必填" });
          return;
        }
        const r = await seamCall<DshToolBridgeResponse>("@action/dsh-tool", {
          action: "call",
          name: body.name.trim(),
          args: body.args ?? {},
        });
        json(res, 200, r.ok ? r.value : { ok: false, error: String(r.error ?? "桥调用失败") });
        return;
      }
      if (path === "/api/aigility/tasks" && req.method === "GET") {
        const url = new URL(req.url ?? "/", "http://x");
        const tasks = await listTasks({
          status: url.searchParams.get("status") ?? undefined,
          createdBy: url.searchParams.get("mine") === "1" ? sessionUserId(req) ?? undefined : undefined,
        });
        json(res, 200, { ok: true, tasks });
        return;
      }
      if (path === "/api/aigility/tasks" && req.method === "POST") {
        // 新建任务：human 留 open 待人办；content/docx 立即异步派发执行器（open→running→review）
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { title?: string; detail?: string; executor?: string; priority?: string };
          if (!body.title?.trim()) {
            json(res, 400, { ok: false, error: "title 必填" });
            return;
          }
          const executor = ["human", "content", "docx", "workflow"].includes(body.executor ?? "") ? body.executor! : "human";
          const userId = requireUser(req, res);
          if (!userId) return;
          const email = (await emailById(userId)) ?? "unknown";
          const task = await createTask({
            title: body.title.trim(),
            detail: body.detail?.trim(),
            executor,
            priority: body.priority?.trim() || undefined,
            createdBy: email,
          });
          if (executor !== "human") void dispatchExecutorTask(task);
          console.log(`[task] 新建 ${executor} 任务「${task.title}」 (${task.id})`);
          json(res, 200, { ok: true, task });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      const transMatch = path.match(/^\/api\/aigility\/tasks\/([\w-]+)\/transition$/);
      if (transMatch && req.method === "POST") {
        // 人在回路流转：human 完成（open→done）/ 审批（review→done|rejected），CAS + 审计
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { to?: string };
          const to = body.to ?? "";
          const legal: Record<string, string[]> = { open: ["done"], review: ["done", "rejected", "running"], running: ["failed", "done"], failed: ["running"] };
          const userId = requireUser(req, res);
          if (!userId) return;
          const email = (await emailById(userId)) ?? "unknown";
          const current = await getTask(transMatch[1]);
          if (!current) { json(res, 404, { ok: false, error: "任务不存在" }); return; }
          if (!legal[current.status]?.includes(to)) {
            json(res, 400, { ok: false, error: `非法流转 ${current.status} → ${to}` });
            return;
          }
          const updated = await transitionTask(transMatch[1], current.status, to, to === "done" && current.result ? current.result : undefined);
          if (!updated) { json(res, 409, { ok: false, error: "状态已被并发修改" }); return; }
          void writeAudit("task.transition", email, `${current.title}: ${current.status} → ${to}`);
          if (current.status === "review" && to === "running" && current.executor === "workflow") {
            executeWorkflowYaml(current);
          }
          json(res, 200, { ok: true, task: updated });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/usage" && req.method === "GET") {
        // Token 用量（真）：D1 token-metering 共享账本（D2 每次推理自动上报）
        const summary = await seamCall<{ summary: Record<string, unknown> }>("@infrastructure/token-metering", { action: "summary" });
        const recent = await seamCall<{ entries: unknown[] }>("@infrastructure/token-metering", { action: "query", query: { limit: 12 } });
        json(res, 200, {
          ok: true,
          summary: summary.ok ? summary.value?.summary : null,
          recent: recent.ok ? recent.value?.entries : [],
          error: summary.ok ? undefined : String(summary.error ?? ""),
        });
        return;
      }
      if (path === "/api/aigility/audit" && req.method === "GET") {
        json(res, 200, { ok: true, entries: await recentAudit(20) });
        return;
      }
      if (path === "/api/aigility/team" && req.method === "GET") {
        json(res, 200, { ok: true, members: await listTeamMembers() });
        return;
      }
      if (path === "/api/aigility/credit" && req.method === "GET") {
        // 积分余额（真）：D1 credit 账务（PgCreditStore），账户按邮箱归集
        const email = await emailById(requireUser(req, res) ?? "");
        const r = await seamCall("@infrastructure/credit", { action: "balance", userId: email ?? "" });
        json(res, 200, { ok: true, userId: email, ...(r.value as object) });
        return;
      }
      if (path === "/api/aigility/doc" && req.method === "POST") {
        // 文档工人（真）：D3 @action/doc-worker，结构化块 → 服务端 docx base64
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
          if (!String(body.title ?? "").trim()) {
            json(res, 400, { ok: false, error: "title 必填" });
            return;
          }
          const r = await seamCall("@action/doc-worker", body);
          json(res, 200, r.ok ? (r.value as object) : { ok: false, error: String(r.error ?? "生成失败") });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/timem/search" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as {
            query?: string; agent_id?: string; user_id?: string; limit?: number;
          };
          if (!body.query?.trim()) {
            json(res, 400, { error: "query 必填" });
            return;
          }
          const result = await seamCall("@action/timem-memory", {
            query: body.query.trim(),
            agent_id: body.agent_id,
            user_id: body.user_id,
            limit: body.limit ?? 5,
          });
          if (!result.ok || result.value?.ok === false) {
            json(res, 200, { ok: false, error: String(result.error ?? result.value?.error ?? "检索失败") });
            return;
          }
          json(res, 200, { ok: true, data: result.value });
        } catch (err) {
          json(res, 200, { ok: false, error: String(err) });
        }
        return;
      }
      json(res, 404, { error: "unknown aigility api" });
      return;
    }

    // ── 静态前端（app/dist, SPA 回退）──
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let filePath = normalize(join(DIST_DIR, path === "/" ? "index.html" : path));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(DIST_DIR, "index.html");
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("前端产物缺失：先执行 pnpm --filter @aigility-harness/aigility-platform build");
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(filePath));
  });
  await new Promise<void>((r) => server.listen(WEB_PORT, "0.0.0.0", () => r()));

  console.log(`\nAigility 智悦智能平台已就绪:`);
  console.log(`  平台前端:     http://127.0.0.1:${WEB_PORT}/  （登录 → 市场真 persona + 工厂真发布 + 对话同源会话代理）`);
  console.log(`  演示账号:     admin@aigility.local/admin123 · fde@aigility.local/fde123 · demo@aigility.local/demo123（与 AppBase 共库共账号）`);
  console.log(`  AI 网关:      http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions (OpenAI 兼容, Bearer 鉴权)`);
  console.log(`                /api/aigility-chat → @persona/aigility-agent（工厂技能 + 平台管家）`);
  console.log(`                ${personas.map((p) => p.personaId.replace("@persona/", "")).join(" · ")} → 引擎原生角色`);
  console.log(`  网关密钥:     仅服务端持有（app_keys 表持久 · 用量上报 llm_usage · 不注入前端页面）`);
  console.log(`  已发布技能:   ${listSkills().length} 个 (data/aigility-skills.json)`);
  const llmDesc = process.env.LLM_PROVIDER === "stub"
    ? "stub 降级（未检测到 BIGMODEL_API_KEY / LITELLM_URL, 回复带【服务降级】标记）"
    : `${process.env.LLM_PROVIDER} 上游`;
  console.log(`  LLM:          ${llmDesc}`);
  console.log(`\nCtrl+C 退出`);

  // 优雅退出
  const shutdown = async () => {
    await stopHttpServer();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
