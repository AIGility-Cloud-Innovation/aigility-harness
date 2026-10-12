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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { plugin as orchestrationPlugin, YamlWorkflow, parseWorkflowYaml } from "@aigility-harness/layer-orchestration";
import { plugin as actionPlugin } from "@aigility-harness/layer-action";
import { createPyBridgePlugin, loadPyPluginsConfig } from "@aigility-harness/py-bridge";
import { isKnownGatewayKey, writeAudit } from "@aigility-harness/appbase/backend";
import { dshLoadPlugin, dshStatus, dshUnloadPlugin } from "@aigility-harness/appbase/dsh-host";
import { ensureAigilityPlatform, routePlatform, sessionUserId, listTeamMembers, recentAudit, emailById, usageSummaryFromPg,
  createTask, listTasks, transitionTask, getTask, type TaskRow,
  listModuleState, setModuleState, listModulePresets, saveModulePreset, applyModulePreset, deleteModulePreset,
  listNavHidden, setNavHidden, isUserAdmin, listNavPrefs,
  getChatPrefs, saveChatPrefs, isThinkingLevel,
  listDshPluginRows, insertDshPlugin, setDshPluginEnabled, deleteDshPluginRow, type DshPluginRow } from "./platform.js";
import { workspaceRoots, browseWorkspace, resolveWorkspace } from "./workspace.js";
import { aigilityAgentPlugin } from "./aigility-agent.js";
import { siteImproverPlugin, SITE_IMPROVER_PERSONA_ID, SITE_IMPROVER_ROUTE, setTaskFiledHook } from "./site-improver.js";
import { dshToolBridgePlugin } from "./dsh-tool.js";
import { fdeLedgerPlugin } from "./fde-ledger.js";
import { listSkills, visibleSkills, getSkill, upsertSkill, removeSkill, persistOwner, setSkillVisibility, usageSnapshot, type AigilitySkill, type AigilitySkillInput } from "./skill-registry.js";
import { getMarketConfig, setMarketDataMode, type MarketDataMode } from "./market-config.js";
import { loadRoles, upsertRole, removeRole, setRoute, checkSkillPaths, listDshSkills, createDshSkill, attachSkillToRole, listMcpShelf, type RoleCapabilityConfig, type RoleMcpServer } from "./role-registry.js";
import { listTweaks, addTweak, removeTweak, type SiteTweak } from "./site-tweaks.js";
import {
  taskLoopStatus, startTaskLoop, stopTaskLoop, restartTaskLoop,
  loadTaskLoopConfig, saveTaskLoopConfig, taskLoopLogs,
  taskLoopConfigView, listFeishuChats, fetchTaskLoopBoard,
} from "./task-loop-manager.js";
import {
  teamMemoryStatus, runTeamMemoryJob, loadTeamMemoryConfig, saveTeamMemoryConfig,
  teamMemoryLogs, teamMemoryConfigView, listTeamMemoryChats, startTeamMemoryScheduler,
  type TeamMemoryJobKind,
} from "./team-memory-manager.js";
import { startManagedApps } from "./managed-apps.js";
import {
  fetchLogMonitorStatus, saveLogMonitorConfig, logMonitorLogs,
  startLogMonitor, stopLogMonitor, restartLogMonitor,
} from "./log-monitor-manager.js";
import {
  identityOverview, runIdentityAutoMatch, identityBind,
  type IdentityBindRequest,
} from "./identity-manager.js";
import type { DshToolBridgeResponse } from "./dsh-tool.js";
import { planTask, WORKFLOW_DIR } from "./planner.js";
import { buildAggregatorPlanFromConfig, SITE_ROLES_DIR } from "./channel-aggregator.js";
import { loadRolePackage, loadRolePackages, validateRoleManifest, validateSitePersona, buildPromotion, bundledRolesDir, toElizaCharacter, fromElizaCharacter, type RoleManifest } from "@aigility-harness/role-kit";
import { checkPermissions, resolveUserPermissionKeys, assignRoleToUser, revokeRoleFromUser, setRolePermissionGroups } from "@aigility-harness/rbac";
import { ensureRbacReady, rbacStore } from "./rbac-store.js";
import { ensureLlmNodeReady, llmNodeStore } from "./llm-node-store.js";
import { resolveLLMNode } from "@aigility-harness/layer-cognitive/llm-node";
import { existsSync as fileExists, mkdirSync, cpSync, rmSync, renameSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.AIGILITY_WEB_PORT ?? 1236);
const GATEWAY_PORT = Number(process.env.AIGILITY_GATEWAY_PORT ?? 1237);
const DIST_DIR = resolve(__dirname, "../app/dist");
// 仓库根 = examples/aigility-platform/(src|dist) → ../../ (examples → aigility-harness)
const REPO_ROOT = resolve(__dirname, "../../..");

/** 网关模型 id → 供应商标签（按 ~/.local/litellm-venv/config.yaml 的 model_name 前缀分组约定） */
function gatewayProviderOf(id: string): string {
  if (id.startsWith("ksyun-")) return "金山云 KSyun";
  if (id.startsWith("bigmodel-")) return "智谱 BigModel";
  if (id.startsWith("sensenova-")) return "商汤 SenseNova";
  if (id.startsWith("claude-")) return "Claude 兼容别名";
  if (id.startsWith("qwen2.5")) return "本机 Ollama";
  if (id === "qwen3.5") return "本机 Ollama";   // 本机 ollama/qwen3.5:latest（云端全挂兜底）
  if (id.startsWith("qwen")) return "阿里云 DashScope";
  if (id === "deepseek-v4-flash") return "阿里云 DashScope";
  if (id.startsWith("deepseek")) return "DeepSeek";
  return "其他";
}

// 网关路由健康缓存：/health 会逐路由探测（38 条、分钟级，ollama 冷启动更慢），
// 不能阻塞模型池接口（对话页三件套共用）——后台低频刷新（5min TTL）+ 内存缓存。
let gatewayHealthCache = { healthy: 0, unhealthy: 0, at: 0 };
const GATEWAY_HEALTH_TTL_MS = 5 * 60_000;

function refreshGatewayHealth(gatewayKey: string): void {
  if (Date.now() - gatewayHealthCache.at < GATEWAY_HEALTH_TTL_MS) return;
  gatewayHealthCache.at = Date.now();
  // 健康计数取 LiteLLM 本体（LITELLM_URL=:48724）——AIGILITY_GATEWAY_PORT(:1237) 是
  // AppBase 网关（OpenAI 兼容代理），没有 /health；模型池两边等价，健康只有 litellm 有
  const litellmBase = (process.env.LITELLM_URL ?? "http://127.0.0.1:48724").replace(/\/$/, "");
  void fetch(`${litellmBase}/health`, {
    // litellm 的 master key（.env LITELLM_KEY），不是 AppBase 侧的 platform gatewayKey
    headers: { Authorization: `Bearer ${process.env.LITELLM_KEY ?? gatewayKey}` },
    signal: AbortSignal.timeout(120_000),
  })
    .then((x) => x.json() as Promise<{ healthy_count?: number; unhealthy_count?: number }>)
    .then((j) => {
      gatewayHealthCache = {
        healthy: Number(j.healthy_count ?? 0),
        unhealthy: Number(j.unhealthy_count ?? 0),
        at: Date.now(),
      };
    })
    .catch(() => { gatewayHealthCache.at = 0; });
}

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
  source: "harness" | "local";
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
  // 示例本地角色（随平台自带, 不入框架层 persona 注册表）
  out.push({
    personaId: SITE_IMPROVER_PERSONA_ID,
    route: SITE_IMPROVER_ROUTE,
    name: "平台改进专员",
    cat: "流程辅助",
    desc: "接收对平台网站的修改意见：聊清需求后自动落任务板并派发编码代理改代码，人审后生效",
    source: "local",
  });
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
  // py-bridge: 任务板 workflow 执行器 Do 段（人审批准 → run_yaml_workflow, aigility SDK ≥2.1.0）。
  // 用平台专用声明 config/py-plugins-aigility-platform.json, 不装载共享 config/py-plugins.json：
  // 共享文件里的 Python 版 @orchestration/workflow-engine（wecom 系工作流）与本平台对话链路的
  // TS workflow-engine 同 id, resolve 取先注册者 + autoHotSwap 健康切换可能改绑, 会劫持对话编排。
  const pyBridgePlugin = createPyBridgePlugin(
    loadPyPluginsConfig(resolve(process.env.PY_PLUGINS_CONFIG || join(REPO_ROOT, "config/py-plugins-aigility-platform.json"))),
  );
  const plugins = [
    infrastructurePlugin,
    pyBridgePlugin,
    cognitivePlugin,
    personaPlugin,
    orchestrationPlugin,
    actionPlugin,
    aigilityAgentPlugin,
    siteImproverPlugin,
    dshToolBridgePlugin,
    // fde-ledger：FDE 生意台账域包（fde-workbench 核心资产插入智悦，共库直读 + 方案 DOCX；
    // 自 feat/fde-into-aigility 摘取回归，仅域包 + API + 前端页，不含壳方向裁剪）
    fdeLedgerPlugin,
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
        : process.env.LITELLM_URL && process.env.LITELLM_KEY
          ? {
              modelsUpstream: { url: process.env.LITELLM_URL, key: process.env.LITELLM_KEY },
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

  // ── 执行器路由 (数据面): 编排声明在 workflows/executor-dispatch.yaml ──
  // 路由表 (节点 + 条件边) 可版本化/人审; 本文件只注册节点函数与条件函数,
  // 改路由/改提示词动 YAML, 不动代码 (扩展 code/mcp 等新执行器同理)。
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

  /** content/docx 共用的 LLM 执行: 走 workflow-engine Seam; 提示词来自 YAML 节点的 system_prompt */
  const runExecutorLlm = async (task: TaskRow, systemPrompt: string): Promise<string> => {
    const wf = await seamCall<{ result?: string; response?: string }>("@orchestration/workflow-engine", {
      user_input: `【任务】${task.title}\n${task.detail ?? ""}`,
      system_prompt: systemPrompt,
      agent_name: "Aigility 任务执行器",
      user_key: task.createdBy,
    });
    const text = (wf.ok ? (wf.value?.result ?? wf.value?.response) : null) ?? "";
    if (!wf.ok || !text.trim()) throw new Error(wf.ok ? "执行器无产出" : String(wf.error ?? "workflow-engine 调用失败"));
    return text;
  };

  // ── workflow 执行器 · Plan 段：LLM 拆解 → YAML 落盘 → review 人审 ──
  const dispatchWorkflowPlanner = (task: TaskRow): Promise<void> =>
    (async () => {
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

  // ── code 执行器：需求交编码代理改代码（平台改进专员链路的执行端） ──
  // 代理可用 CODE_EXECUTOR_AGENT_ID 切换（默认 @action/codex-agent —— 本机 zcode CLI
  // headless 模式无法创建模型，交互式账号订阅不适用于无人值守 spawn）。
  // 安全边界：改动落工作区 git diff，任务进 review 人审（rejected/回滚走 git）；
  // 编码代理不 commit、不碰凭证，约束写在 YAML 节点的 system_prompt。
  const CODE_AGENT_ID = process.env.CODE_EXECUTOR_AGENT_ID ?? "@action/codex-agent";
  const dispatchCodeExecutor = (task: TaskRow, rules: string): Promise<void> =>
    (async () => {
      try {
        const requirement = [`【任务标题】${task.title}`, task.detail ? `【需求详情】\n${task.detail}` : ""]
          .filter(Boolean)
          .join("\n\n");
        const r = await seamCall<{ text?: string; error?: string }>(CODE_AGENT_ID, {
          prompt: `${rules}\n\n=== 本次改动需求 ===\n${requirement}`,
          cwd: REPO_ROOT,
          skipPlanning: true,
          timeoutMs: Number(process.env.CODE_EXECUTOR_TIMEOUT_MS) || 600_000,
        });
        if (!r.ok) throw new Error(String(r.error ?? "编码代理调用失败"));
        const text = r.value?.text?.trim();
        if (!text) throw new Error("编码代理无输出");
        await transitionTask(task.id, "running", "review", { kind: "text", text });
        console.log(`[task] 编码执行器完成「${task.title}」→ review (待人审 git diff)`);
      } catch (err) {
        await transitionTask(task.id, "running", "failed", { kind: "error", text: `编码执行失败：${String(err)}` }).catch(() => {});
        console.error(`[task] 编码执行失败「${task.title}」:`, err);
      }
    })();

  // ── 执行器路由驱动器: 读 executor-dispatch.yaml → 校验 → 按任务沿边执行 ──
  const DISPATCH_YAML = resolve(__dirname, "../workflows/executor-dispatch.yaml");
  const dispatchWorkflow = (() => {
    try {
      const wf = new YamlWorkflow<{ task: TaskRow; executor?: string; result?: string }>(
        parseWorkflowYaml(readFileSync(DISPATCH_YAML, "utf-8")),
      );
      wf.registerNodes({
        // classify: 取 executor 字段作为条件边分支键
        classify: (s) => ({ executor: s.task.executor }),
        // content/docx: LLM 执行器 (提示词读 YAML 节点 system_prompt), 产出 → review 人在回路
        content: async (s, node) => {
          const text = await runExecutorLlm(s.task, String(node.system_prompt ?? ""));
          await transitionTask(s.task.id, "running", "review", { kind: "text", text });
          console.log(`[task] 执行器完成「${s.task.title}」→ review`);
        },
        docx: async (s, node) => {
          const text = await runExecutorLlm(s.task, String(node.system_prompt ?? ""));
          const doc = await seamCall<{ filename?: string; base64?: string; bytes?: number; error?: string }>("@action/doc-worker", {
            title: s.task.title, subtitle: `执行器产出 · ${s.task.createdBy}`, blocks: parseBlocks(text),
          });
          if (!doc.ok || !doc.value?.base64) throw new Error(doc.value?.error ?? "doc-worker 生成失败");
          await transitionTask(s.task.id, "running", "review", {
            kind: "file", text, filename: doc.value.filename, base64: doc.value.base64, bytes: doc.value.bytes,
          });
          console.log(`[task] 执行器完成「${s.task.title}」→ review (docx)`);
        },
        // workflow: 交 PDCA 拆解器 (Plan 段, 内部自带状态流转与异常善后)
        dispatch_workflow_planner: (s) => dispatchWorkflowPlanner(s.task),
        // code: 交 ZCode 编码代理改代码 (约束读 YAML 节点 system_prompt), 产出 → review 人审
        dispatch_code_executor: (s, node) => dispatchCodeExecutor(s.task, String(node.system_prompt ?? "")),
        // human: 不派发, 保持 open (路由完备性占位; 正常不会走到)
        mark_open: (s) => {
          console.log(`[task] 人工任务「${s.task.title}」保持 open, 不派发执行器`);
        },
      });
      wf.registerCondition("route_by_executor", (s) => s.executor ?? "");
      const { errors } = wf.validate();
      if (errors.length) throw new Error(`路由 YAML 校验失败: ${errors.join("; ")}`);
      return wf;
    } catch (e) {
      console.error(`[task] 执行器路由加载失败 (${DISPATCH_YAML}):`, e);
      return null;
    }
  })();

  /** 派发执行器: open→running 后交 YAML 路由; 任何失败 → running→failed */
  const dispatchExecutorTask = (task: TaskRow): void => {
    void (async () => {
      try {
        if (!dispatchWorkflow) throw new Error("执行器路由 YAML 不可用 (启动时加载失败, 见服务端日志)");
        await transitionTask(task.id, "open", "running");
        const run = await dispatchWorkflow.run({ task, executor: task.executor });
        if (!run.ok) throw new Error(run.errors.join("; "));
      } catch (err) {
        await transitionTask(task.id, "running", "failed", { kind: "error", text: String(err) }).catch(() => {});
        console.error(`[task] 执行器失败「${task.title}」:`, err);
      }
    })();
  };
  // 平台改进专员落的任务同样自动派发（对齐 HTTP 建任务接口的 `executor!=="human"` 行为）
  setTaskFiledHook((t) => dispatchExecutorTask(t));

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
          ? `${msg}（py-bridge 未提供该能力：检查 config/py-plugins-aigility-platform.json 与 aigility SDK venv ≥2.1.0，服务启动日志有 py-bridge 装载详情）`
          : msg;
        await transitionTask(task.id, "running", "failed", { kind: "error", text: hint });
        console.error(`[task] 工作流执行失败「${task.title}」:`, err);
      }
    })();
  };
  /** 发布同步：数字员工 → 站点角色包（data/roles/<id>）。
 * 人设事实源以包为准（aigility-agent 读包），账本 prompt 字段降为包缺失时的恢复缓存。
 * 记忆域登记为裸 role_id；运行时旧域 aigility-skill-<id> 记入 legacy_agent_ids（迁移待专门步骤）。 */
function syncSkillPackage(skill: AigilitySkill): void {
  const dir = join(SITE_ROLES_DIR, skill.id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    role_id: skill.id,
    identity: { name: skill.name, signature: skill.category, capability_ref: skill.id },
    sources: { data: skill.knowledge ?? [] },
    actions: { tools: skill.tools ?? [], workflows: [] },
    outbound: { reply: "same-channel" as const },
    memory: { agent_id: skill.id, legacy_agent_ids: [`aigility-skill-${skill.id}`] },
  };
  const tmp = `${dir}/role.json.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, `${dir}/role.json`);
  const md = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.prompt.trim()}\n`;
  writeFileSync(`${dir}/SKILL.md.tmp`, md, "utf8");
  renameSync(`${dir}/SKILL.md.tmp`, `${dir}/SKILL.md`);
}

/** 角色包写盘（站点层共用）：role.json 原子替换 + SKILL.md（有包则 frontmatter 保留，往返字节稳定） */
function writePackageFiles(targetDir: string, manifest: RoleManifest, prompt: string | undefined, hadPkg: boolean): void {
  const tmp = `${targetDir}/role.json.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, `${targetDir}/role.json`);
  if (prompt?.trim()) {
    let fm = "";
    if (hadPkg && fileExists(`${targetDir}/SKILL.md`)) {
      fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(readFileSync(`${targetDir}/SKILL.md`, "utf8"))?.[0] ?? "";
    } else {
      fm = `---\nname: ${manifest.identity?.name ?? ""}\ndescription: ${manifest.identity?.signature ?? "站点角色"}\n---\n`;
    }
    const tmpMd = `${targetDir}/SKILL.md.tmp`;
    writeFileSync(tmpMd, `${fm}\n${prompt.trim()}\n`, "utf8");
    renameSync(tmpMd, `${targetDir}/SKILL.md`);
  }
}

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
        const viewer = await emailById(sessionUserId(req) ?? "") ?? undefined;
        json(res, 200, {
          personas,
          skills: visibleSkills(viewer),
          llm: process.env.LLM_PROVIDER ?? "stub",
        });
        return;
      }
      if (path === "/api/aigility/skills" && req.method === "GET") {
        json(res, 200, { skills: visibleSkills(await emailById(sessionUserId(req) ?? "") ?? undefined) });
        return;
      }
      if (path === "/api/aigility/skills" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as Partial<AigilitySkillInput>;
          if (!body.name?.trim() || !body.prompt?.trim() || !body.description?.trim()) {
            json(res, 400, { error: "发布至少需要名称、能力描述与角色 Prompt" });
            return;
          }
          // 可见性纪律：企业内（=上架市场）是管理员动作；普通用户发布一律 仅自己
          // （数字员工工作台对自己可见，不上架市场）。覆盖他人发布同样仅限发布者或管理员。
          const pubUid = sessionUserId(req);
          const pubAdmin = pubUid ? await isUserAdmin(pubUid) : false;
          const pubViewer = await emailById(pubUid ?? "") ?? "";
          if (body.id?.trim()) {
            const existing = getSkill(body.id.trim());
            if (existing && !pubAdmin && (existing.owner ?? "admin@aigility.local") !== pubViewer) {
              json(res, 403, { error: "仅发布者或管理员可修改该数字员工" });
              return;
            }
          }
          const skill = upsertSkill({
            id: body.id?.trim() || `zy-${Date.now().toString(36)}`,
            name: body.name.trim(),
            category: body.category?.trim() || "知识服务",
            description: body.description.trim(),
            tags: Array.isArray(body.tags) ? body.tags : [],
            modelId: body.modelId?.trim() || "sensenova-deepseek-v4-flash",
            prompt: body.prompt.trim(),
            temperature: typeof body.temperature === "number" ? body.temperature : 0.3,
            knowledge: Array.isArray(body.knowledge) ? body.knowledge : [],
            tools: Array.isArray(body.tools) ? body.tools : [],
            visibility: pubAdmin ? (body.visibility?.trim() || "企业内") : "仅自己",
            releaseNote: body.releaseNote?.trim() || "",
          });
          skill.owner = await emailById(sessionUserId(req) ?? "") ?? undefined; // 仅自己 可见性的判据
          persistOwner(skill.id, skill.owner);
          syncSkillPackage(skill); // 发布即同步站点角色包（人设事实源）
          console.log(`[工厂] 数字员工「${skill.name}」已发布 (id=${skill.id}, owner=${skill.owner ?? "?"}, visibility=${skill.visibility}${!pubAdmin && body.visibility === "企业内" ? "，普通用户发布由企业内降为仅自己" : ""}) → @persona/aigility-agent 可按 skill_id 对话`);
          json(res, 200, { skill });
        } catch (err) {
          json(res, 400, { error: String(err) });
        }
        return;
      }
      const delMatch = path.match(/^\/api\/aigility\/skills\/([\w-]+)$/);
      if (delMatch && req.method === "DELETE") {
        // 下架保护：仅发布者或管理员（防止普通用户摘除管理员的市场的货架）
        const delUid = sessionUserId(req) ?? "";
        if (!(await isUserAdmin(delUid))) {
          const delViewer = await emailById(delUid) ?? "";
          const target = getSkill(delMatch[1]);
          if (!target || (target.owner ?? "admin@aigility.local") !== delViewer) {
            json(res, 403, { error: "仅发布者或管理员可下架该数字员工" });
            return;
          }
        }
        json(res, 200, { ok: removeSkill(delMatch[1]) });
        return;
      }
      // 可见范围单独更新（管理员上架/撤下市场）：企业内 = 普通用户在智能体市场可见
      const visMatch = path.match(/^\/api\/aigility\/skills\/([\w-]+)\/visibility$/);
      if (visMatch && req.method === "PUT") {
        const actor = sessionUserId(req);
        if (!actor) { json(res, 401, { error: "需要登录" }); return; }
        if (!(await isUserAdmin(actor))) { json(res, 403, { error: "仅管理员可调整市场上架范围" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { visibility?: string };
        if (body.visibility !== "企业内" && body.visibility !== "仅自己") {
          json(res, 400, { error: "visibility 只能是企业内或仅自己" });
          return;
        }
        const skill = setSkillVisibility(visMatch[1], body.visibility);
        if (!skill) { json(res, 404, { error: "数字员工不存在" }); return; }
        void writeAudit(actor, "market.shelf", skill.id, `可见范围 → ${body.visibility}`);
        console.log(`[市场] 数字员工「${skill.name}」(id=${skill.id}) 可见范围 → ${body.visibility}`);
        json(res, 200, { skill });
        return;
      }

      // ── 智能体市场数据模式（站点级）：mock=演示模板（缺省，管理员未设置时）· real=工厂发布（企业内可见=上架）──
      if (path === "/api/aigility/market-config" && req.method === "GET") {
        json(res, 200, getMarketConfig());
        return;
      }
      if (path === "/api/aigility/market-config" && req.method === "PUT") {
        const actor = sessionUserId(req);
        if (!actor) { json(res, 401, { error: "需要登录" }); return; }
        if (!(await isUserAdmin(actor))) { json(res, 403, { error: "市场数据模式由管理员统一配置" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { dataMode?: MarketDataMode };
        if (body.dataMode !== "mock" && body.dataMode !== "real") {
          json(res, 400, { error: "dataMode 只能是 mock 或 real" });
          return;
        }
        const config = setMarketDataMode(body.dataMode);
        void writeAudit(actor, "market.config", "data-mode", config.dataMode === "real" ? "真实数据（工厂发布上架）" : "模拟数据（演示模板）");
        console.log(`[市场] 数据模式 → ${config.dataMode}`);
        json(res, 200, { ok: true, ...config });
        return;
      }

      // ── 角色能力注册表（DSH 渠道）：role → skills/MCP，写 roles.json 热生效 ──
      if (path === "/api/aigility/roles" && req.method === "GET") {
        const doc = loadRoles();
        json(res, 200, { ...doc, missingSkills: checkSkillPaths(doc), registryFile: process.env.DSH_ROLE_REGISTRY ?? "examples/feishu-dsh/roles.json" });
        return;
      }
      if (path === "/api/aigility/roles" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as {
            id?: string; label?: string; skills?: string[]; mcpServers?: RoleMcpServer[];
          };
          if (!body.id?.trim()) {
            json(res, 400, { error: "缺少角色 id" });
            return;
          }
          const config = upsertRole(body.id.trim(), {
            label: body.label,
            skills: body.skills,
            mcpServers: body.mcpServers,
          });
          console.log(`[角色能力] 角色「${body.id}」已保存 (skills=${config.skills?.length ?? 0}, mcp=${config.mcpServers?.length ?? 0}) → DSH 会话中继热生效`);
          json(res, 200, { ok: true, id: body.id.trim(), config });
        } catch (err) {
          json(res, 400, { error: String((err as Error)?.message ?? err) });
        }
        return;
      }
      const roleDelMatch = path.match(/^\/api\/aigility\/roles\/([\w.-]{1,64})$/);
      if (roleDelMatch && req.method === "DELETE") {
        json(res, 200, { ok: removeRole(roleDelMatch[1]) });
        return;
      }
      if (path === "/api/aigility/roles/routes" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { chatKey?: string; roleId?: string };
          if (!body.chatKey?.trim()) {
            json(res, 400, { error: "缺少 chatKey（飞书 chatId/userId/appId）" });
            return;
          }
          setRoute(body.chatKey.trim(), body.roleId?.trim() ?? "");
          json(res, 200, { ok: true, routes: loadRoles().routes });
        } catch (err) {
          json(res, 400, { error: String((err as Error)?.message ?? err) });
        }
        return;
      }

      // DSH 技能货架：枚举 / 创建（工厂「同步为 DSH 技能」落点）/ 挂到角色
      if (path === "/api/aigility/dsh-skills" && req.method === "GET") {
        json(res, 200, { skillsRoot: loadRoles().skillsRoot ?? "", skills: listDshSkills() });
        return;
      }
      if (path === "/api/aigility/dsh-skills" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as {
            name?: string; description?: string; prompt?: string; attachRole?: string;
          };
          if (!body.name?.trim() || !body.description?.trim() || !body.prompt?.trim()) {
            json(res, 400, { error: "创建 DSH 技能至少需要名称、描述与 Prompt" });
            return;
          }
          const skill = createDshSkill({ name: body.name.trim(), description: body.description.trim(), prompt: body.prompt.trim() });
          let attached: string | null = null;
          if (body.attachRole?.trim()) {
            attachSkillToRole(body.attachRole.trim(), skill.dir);
            attached = body.attachRole.trim();
          }
          console.log(`[角色能力] DSH 技能「${skill.dir}」已创建${attached ? ` 并挂到角色 ${attached}` : ""} → 中继热生效`);
          json(res, 200, { ok: true, skill, attached });
        } catch (err) {
          json(res, 400, { error: String((err as Error)?.message ?? err) });
        }
        return;
      }
      const attachMatch = path.match(/^\/api\/aigility\/roles\/([\w.-]{1,64})\/attach-skill$/);
      if (attachMatch && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { skill?: string };
          if (!body.skill?.trim()) {
            json(res, 400, { error: "缺少 skill（技能目录名或绝对路径）" });
            return;
          }
          const config = attachSkillToRole(attachMatch[1], body.skill.trim());
          json(res, 200, { ok: true, config });
        } catch (err) {
          json(res, 400, { error: String((err as Error)?.message ?? err) });
        }
        return;
      }

      // MCP 货架：全角色 server 按 serverName 聚合（供角色页勾选复用）
      if (path === "/api/aigility/mcp-shelf" && req.method === "GET") {
        json(res, 200, { servers: listMcpShelf() });
        return;
      }

      // ── 站点即时微调（改进专员 live_fix 的持久化与重放） ──
      if (path === "/api/aigility/site-tweaks" && req.method === "GET") {
        json(res, 200, { tweaks: listTweaks() });
        return;
      }
      if (path === "/api/aigility/site-tweaks" && req.method === "POST") {
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as Partial<SiteTweak> & { user_key?: string };
          if (!body.selector?.trim() || !["text", "hide", "style"].includes(String(body.type))) {
            json(res, 400, { error: "site-tweak 需要 selector 与合法 type（text|hide|style）" });
            return;
          }
          const row = addTweak({
            type: body.type as SiteTweak["type"],
            selector: body.selector.trim(),
            value: body.value,
            reason: body.reason,
            createdBy: body.user_key ?? "site-improver",
          });
          json(res, 200, { ok: true, tweak: row });
        } catch (err) {
          json(res, 400, { error: String((err as Error)?.message ?? err) });
        }
        return;
      }
      const tweakDelMatch = path.match(/^\/api\/aigility\/site-tweaks\/([\w-]+)$/);
      if (tweakDelMatch && req.method === "DELETE") {
        json(res, 200, { ok: removeTweak(tweakDelMatch[1]) });
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
      // ── 统一台账只读路由（TaskRegistry → 看板） ──────────────────
      if (path === "/api/aigility/registry-tasks" && req.method === "GET") {
        try {
          const regFile = join(REPO_ROOT, "config/task-registry.local.json");
          const raw = readFileSync(regFile, "utf-8");
          const parsed = JSON.parse(raw) as { tasks?: Array<Record<string, unknown>> };
          const tasks = (parsed.tasks ?? []).map((t) => ({
            uid: t.uid,
            title: t.title,
            description: t.description ?? "",
            status: t.status,
            projectRef: t.projectRef ?? "",
            originProvider: (t.origin as { provider?: string })?.provider ?? "",
            assignee: (t.assignee as { provider?: string })?.provider ?? "",
            executor: (t.description as string | undefined)?.match(/执行者：(\S+)/)?.[1] ?? "",
            reviewer: (t.review as { by?: string })?.by ?? "",
            reviewVia: (t.review as { via?: string })?.via ?? "",
            links: t.links ?? {},
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));
          json(res, 200, { ok: true, tasks });
        } catch (e) {
          json(res, 200, { ok: true, tasks: [], error: String(e) });
        }
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
          const executor = ["human", "content", "docx", "workflow", "code"].includes(body.executor ?? "") ? body.executor! : "human";
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
        // Token 用量（真 · 双账本归一）：优先 PG llm_usage（网关每次完成上报 /app/usage/collect
        // 持久, 口径=网关全量, 重启不丢）; PG 不可用/空表回退内存账本（仅本会话）。
        // recent 尾巴始终取内存账本（近期明细, 无需持久）。
        const pg = await usageSummaryFromPg();
        const summary = pg
          ? {
              total: pg.calls, calls: pg.calls,
              promptTokens: pg.promptTokens, completionTokens: pg.completionTokens, totalTokens: pg.totalTokens,
              measuredCalls: pg.calls, estimatedCalls: 0,
              byUser: [] as unknown[], byModel: pg.byModel, byDay: pg.byDay,
            }
          : await (async () => {
              const m = await seamCall<{ summary: Record<string, unknown> }>("@infrastructure/token-metering", { action: "summary" });
              return m.ok ? m.value?.summary ?? null : null;
            })();
        const recent = await seamCall<{ entries: unknown[] }>("@infrastructure/token-metering", { action: "query", query: { limit: 12 } });
        json(res, 200, {
          ok: true,
          summary,
          recent: recent.ok ? recent.value?.entries : [],
          source: pg ? "pg" : "memory",
        });
        return;
      }
      if (path === "/api/aigility/audit" && req.method === "GET") {
        json(res, 200, { ok: true, entries: await recentAudit(20) });
        return;
      }

      // ── 编排管理（真 · 数据面工作流 YAML：清单/读取/保存, 服务端校验 + 审计）──
      if (path === "/api/aigility/flows" && req.method === "GET") {
        const { readdirSync, statSync } = await import("node:fs");
        const flows: Array<{ id: string; name: string; source: string; builtin: boolean }> = [
          { id: "executor-dispatch", name: "任务板执行器路由", source: "workflows/executor-dispatch.yaml", builtin: true },
        ];
        try {
          for (const f of readdirSync(WORKFLOW_DIR)) {
            if (f.endsWith(".yaml") && statSync(resolve(WORKFLOW_DIR, f)).isFile()) {
              flows.push({ id: f.replace(/\.yaml$/, ""), name: `任务拆解工作流`, source: `data/workflows/${f}`, builtin: false });
            }
          }
        } catch { /* 目录缺失时仅内置路由 */ }
        json(res, 200, { ok: true, flows });
        return;
      }
      const flowMatch = path.match(/^\/api\/aigility\/flows\/([\w-]+)$/);
      if (flowMatch && req.method === "GET") {
        const file = flowMatch[1] === "executor-dispatch"
          ? resolve(__dirname, "../workflows/executor-dispatch.yaml")
          : resolve(WORKFLOW_DIR, `${flowMatch[1]}.yaml`);
        if (!fileExists(file)) { json(res, 404, { error: `工作流 ${flowMatch[1]} 不存在` }); return; }
        json(res, 200, { ok: true, id: flowMatch[1], yaml: readFileSync(file, "utf-8") });
        return;
      }
      if (flowMatch && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}") as { yaml?: string };
        if (!body.yaml?.trim()) { json(res, 400, { error: "缺少 yaml 内容" }); return; }
        // 服务端校验：结构非法拒绝写盘（对齐启动时 YamlWorkflow.validate 的契约）
        try {
          const wf = new YamlWorkflow(parseWorkflowYaml(body.yaml));
          wf.registerNodes({
            classify: () => ({}), content: async () => {}, docx: async () => {},
            dispatch_workflow_planner: () => {}, dispatch_code_executor: () => {}, mark_open: () => {},
          });
          wf.registerCondition("route_by_executor", () => "");
          const { errors } = wf.validate();
          if (errors.length) { json(res, 400, { error: `工作流校验失败: ${errors.join("; ")}` }); return; }
        } catch (e) {
          json(res, 400, { error: `YAML 解析失败: ${String(e)}` });
          return;
        }
        const file = flowMatch[1] === "executor-dispatch"
          ? resolve(__dirname, "../workflows/executor-dispatch.yaml")
          : resolve(WORKFLOW_DIR, `${flowMatch[1]}.yaml`);
        if (!fileExists(file)) { json(res, 404, { error: `工作流 ${flowMatch[1]} 不存在（新建走任务板 Plan 拆解）` }); return; }
        writeFileSync(file, body.yaml, "utf-8");
        void writeAudit(sessionUserId(req) ?? "unknown", "flow.save", flowMatch[1], `${body.yaml.length} 字节（校验通过）`);
        json(res, 200, { ok: true, note: "已保存并校验通过；任务派发在下次加载时使用新配置（编辑器内即时生效）" });
        return;
      }
      // ── 模型池（真 · 网关 /v1/models 代理, 主密钥仅服务端）与工作流清单（D4 编排委托数据源）──
      if (path === "/api/aigility/llm/models" && req.method === "GET") {
        try {
          const gh = { Authorization: `Bearer ${gatewayKey}` };
          const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/models`, {
            headers: gh,
            signal: AbortSignal.timeout(5000),
          });
          const j = await r.json() as { data?: Array<{ id: string }> };
          const models = (j.data ?? []).map((m) => m.id).sort();
          // 模型管理页（2026-10-07）：合并 /v1/model/info（上下文/输出上限），把演示矩阵换成真数据。
          // /health 逐路由探测分钟级、不能阻塞本接口（对话页模型池共用）→ 后台刷新 + 缓存。
          const infoR = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/model/info`, { headers: gh, signal: AbortSignal.timeout(8000) }).then((x) => x.json() as Promise<{ data?: Array<{ model_name?: string; model_info?: Record<string, unknown> }> }>).catch(() => null);
          refreshGatewayHealth(gatewayKey);
          const infoMap = new Map<string, { maxIn?: number; maxOut?: number }>();
          for (const m of infoR?.data ?? []) {
            if (!m.model_name) continue;
            const mi = m.model_info ?? {};
            infoMap.set(m.model_name, {
              maxIn: Number(mi.max_input_tokens) || undefined,
              maxOut: Number(mi.max_output_tokens) || Number(mi.max_tokens) || undefined,
            });
          }
          const entries = models.map((id) => ({ id, provider: gatewayProviderOf(id), ...(infoMap.get(id) ?? {}) }));
          const health = { ...gatewayHealthCache };
          json(res, 200, { ok: true, models, entries, health, source: "gateway" });
        } catch (err) {
          json(res, 200, { ok: false, models: [], error: `网关模型池不可达: ${String(err)}` });
        }
        return;
      }
      // ── 数字员工对话三件套（真 · per-user 持久化）：模型 / 思考等级 / 本地工作区 ──
      // 「模型」取值来自网关模型池；「思考等级」是站点定义的枚举（auto/off/low/medium/high），
      // 前端按所选模型把档位翻译成供应商参数直通上游；「工作区」是服务端可见目录（白名单内）。
      if (path === "/api/aigility/chat/prefs" && req.method === "GET") {
        const uid = sessionUserId(req);
        if (!uid) { json(res, 401, { error: "未登录或会话已过期" }); return; }
        json(res, 200, { ok: true, prefs: await getChatPrefs(uid) });
        return;
      }
      if (path === "/api/aigility/chat/prefs" && req.method === "PUT") {
        const uid = sessionUserId(req);
        if (!uid) { json(res, 401, { error: "未登录或会话已过期" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { model?: string; thinking?: string; workspace?: string };
        if (body.thinking !== undefined && !isThinkingLevel(body.thinking)) {
          json(res, 400, { ok: false, error: "思考等级取值须为 auto/off/low/medium/high" });
          return;
        }
        // 工作区落库前必须过白名单（防任意路径写进偏好后被对话链路当授权目录用）
        if (typeof body.workspace === "string" && body.workspace.trim()) {
          const ws = resolveWorkspace(body.workspace);
          if (!ws.ok) { json(res, 400, { ok: false, error: ws.error ?? "工作区不可用" }); return; }
          body.workspace = ws.path;
        }
        const prefs = await saveChatPrefs(uid, body);
        void writeAudit(uid, "chat.prefs.save",
          `model=${prefs.model || "(跟随平台)"} thinking=${prefs.thinking} workspace=${prefs.workspace || "(未选)"}`);
        json(res, 200, { ok: true, prefs });
        return;
      }
      // 工作区根白名单（用户主目录 / 智悦仓库 / tmp，env AIGILITY_WORKSPACE_ROOTS 可追加）
      if (path === "/api/aigility/workspace/roots" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        json(res, 200, { ok: true, roots: workspaceRoots(true) });
        return;
      }
      // 目录浏览（只列子目录；所有路径 realpath 后校验落在白名单根内）
      if (path === "/api/aigility/workspace/browse" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const target = url.searchParams.get("path")?.trim() || workspaceRoots()[0]?.path || "";
        json(res, 200, browseWorkspace(target));
        return;
      }
      if (path === "/api/aigility/workflows" && req.method === "GET") {
        const list: Array<{ id: string; name: string; source: string }> = [
          { id: "executor-dispatch", name: "任务板执行器路由（content/docx/workflow/code/human）", source: "workflows/executor-dispatch.yaml" },
        ];
        try {
          const { readdirSync } = await import("node:fs");
          for (const f of readdirSync(WORKFLOW_DIR)) {
            if (f.endsWith(".yaml")) list.push({ id: f.replace(/\.yaml$/, ""), name: `任务拆解工作流（${f.slice(0, 8)}…）`, source: `data/workflows/${f}` });
          }
        } catch { /* 目录缺失时仅内置路由 */ }
        json(res, 200, { ok: true, workflows: list });
        return;
      }
      // ── 通道聚合（M1 dry-run 装配计划 + M2a manifest 检查/调整：读-改-审一体）──
      if (path === "/api/aigility/channels/plan" && req.method === "GET") {
        const plan = buildAggregatorPlanFromConfig();
        json(res, 200, { ok: true, mode: "dry-run", ...plan });
        return;
      }
      // ── RBAC 鉴权（底座能力 @aigility-harness/rbac · AppBase PG 适配）──
      // 试点强制点：管理端点双门放行（isUserAdmin 过渡 或 rbac system:rbac:manage）——
      // RBAC 自举接管自己的管理面，isUserAdmin 在全面接管后退役。
      const rbacAdminGate = async (): Promise<boolean> => {
        const uid = sessionUserId(req) ?? "";
        if (!uid) return false;
        if (await isUserAdmin(uid)) return true;
        await ensureRbacReady();
        return (await checkPermissions(rbacStore, uid, "system:rbac:manage")).ok;
      };
      if (path === "/api/aigility/rbac/whoami" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const uid = sessionUserId(req) ?? "";
        await ensureRbacReady();
        const keys = [...(await resolveUserPermissionKeys(rbacStore, uid))].sort();
        const urs = await rbacStore.listUserRoles(uid);
        const roles = await rbacStore.listRolesByIds(urs.map((u) => u.roleId));
        json(res, 200, { ok: true, userId: uid, keys, roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })) });
        return;
      }
      if (path === "/api/aigility/rbac/catalog" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        if (!(await rbacAdminGate())) { json(res, 403, { ok: false, error: "需要 system:rbac:manage 权限" }); return; }
        await ensureRbacReady();
        json(res, 200, { ok: true, groups: await rbacStore.listGroups(), permissions: await rbacStore.listPermissions(), roles: await rbacStore.listRoles() });
        return;
      }
      if (path === "/api/aigility/rbac/roles" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await rbacAdminGate())) { json(res, 403, { ok: false, error: "需要 system:rbac:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { code?: string; name?: string; level?: number };
        if (!body.code?.trim() || !body.name?.trim()) { json(res, 400, { ok: false, error: "需要 code 与 name" }); return; }
        const role = await rbacStore.createRole({ code: body.code.trim(), name: body.name.trim(), level: body.level ?? 0 });
        void writeAudit(sessionUserId(req) ?? "unknown", "rbac.role.create", role.code);
        json(res, 200, { ok: true, role });
        return;
      }
      const rbacAssign = path.match(/^\/api\/aigility\/rbac\/assign-role$/);
      if (rbacAssign && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await rbacAdminGate())) { json(res, 403, { ok: false, error: "需要 system:rbac:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { userId?: string; roleId?: number; expireTime?: string };
        if (!body.userId || !body.roleId) { json(res, 400, { ok: false, error: "需要 userId 与 roleId" }); return; }
        await ensureRbacReady();
        await assignRoleToUser(rbacStore, body.userId, body.roleId, body.expireTime ?? null);
        void writeAudit(sessionUserId(req) ?? "unknown", "rbac.role.assign", `${body.userId} → role ${body.roleId}${body.expireTime ? ` · 至 ${body.expireTime}` : ""}`);
        json(res, 200, { ok: true });
        return;
      }
      const rbacRevoke = path.match(/^\/api\/aigility\/rbac\/revoke-role$/);
      if (rbacRevoke && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await rbacAdminGate())) { json(res, 403, { ok: false, error: "需要 system:rbac:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { userId?: string; roleId?: number };
        if (!body.userId || !body.roleId) { json(res, 400, { ok: false, error: "需要 userId 与 roleId" }); return; }
        await revokeRoleFromUser(rbacStore, body.userId, body.roleId);
        void writeAudit(sessionUserId(req) ?? "unknown", "rbac.role.revoke", `${body.userId} ✕ role ${body.roleId}`);
        json(res, 200, { ok: true });
        return;
      }
      const rbacRoleGroups = path.match(/^\/api\/aigility\/rbac\/roles\/([\d]+)\/groups$/);
      if (rbacRoleGroups && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await rbacAdminGate())) { json(res, 403, { ok: false, error: "需要 system:rbac:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { groupIds?: number[] };
        if (!Array.isArray(body.groupIds)) { json(res, 400, { ok: false, error: "需要 groupIds 数组" }); return; }
        await ensureRbacReady();
        await setRolePermissionGroups(rbacStore, Number(rbacRoleGroups[1]), body.groupIds);
        void writeAudit(sessionUserId(req) ?? "unknown", "rbac.role.groups", `role ${rbacRoleGroups[1]} → ${body.groupIds.length} 组`);
        json(res, 200, { ok: true });
        return;
      }
      // ── LLM 节点可视化配置（D2 模型算力层 · 移植自 hire llm_node）──
      const llmAdminGate = async (): Promise<boolean> => {
        const uid = sessionUserId(req) ?? "";
        if (!uid) return false;
        if (await isUserAdmin(uid)) return true;
        await ensureRbacReady();
        return (await checkPermissions(rbacStore, uid, "model:manage")).ok;
      };
      if (path === "/api/aigility/llm/nodes" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        await ensureLlmNodeReady();
        json(res, 200, { ok: true, nodes: await llmNodeStore.listNodes(), providers: await llmNodeStore.listProviders() });
        return;
      }
      if (path === "/api/aigility/llm/providers" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await llmAdminGate())) { json(res, 403, { ok: false, error: "需要 model:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; tag?: string; apiKey?: string; apiBase?: string };
        if (!body.name?.trim() || !body.tag?.trim()) { json(res, 400, { ok: false, error: "需要 name 与 tag" }); return; }
        const provider = await llmNodeStore.createProvider({ name: body.name.trim(), tag: body.tag.trim(), apiKey: body.apiKey ?? "", apiBase: body.apiBase ?? "" });
        void writeAudit(sessionUserId(req) ?? "unknown", "llm.provider.create", provider.tag);
        json(res, 200, { ok: true, provider });
        return;
      }
      const llmNodeResolve = path.match(/^\/api\/aigility\/llm\/nodes\/([\w.-]+)\/resolve$/);
      if (llmNodeResolve && req.method === "GET") {
        if (!requireUser(req, res)) return;
        await ensureLlmNodeReady();
        try {
          const resolved = await resolveLLMNode(llmNodeStore, llmNodeResolve[1]);
          if (!resolved) {
            json(res, 404, { ok: false, error: `LLM 节点不存在或已停用: ${llmNodeResolve[1]}` });
            return;
          }
          json(res, 200, { ok: true, resolved });
        } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        return;
      }
      // 试调用：真发一次极短请求（max_tokens:16）—— 配错立刻可见，不必等生产日志里冒出空响应
      const llmNodeProbe = path.match(/^\/api\/aigility\/llm\/nodes\/([\w.-]+)\/probe$/);
      if (llmNodeProbe && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await llmAdminGate())) { json(res, 403, { ok: false, error: "需要 model:manage 权限" }); return; }
        await ensureLlmNodeReady();
        const probeName = llmNodeProbe[1];
        try {
          const resolved = await resolveLLMNode(llmNodeStore, probeName);
          if (!resolved) { json(res, 404, { ok: false, error: `LLM 节点不存在或已停用: ${probeName}` }); return; }
          const upstream = resolved.baseUrl && resolved.apiKey
            ? { url: resolved.baseUrl, key: resolved.apiKey }
            : undefined;
          const t0 = Date.now();
          const r = await seamCall<{ text: string; finish_reason?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }>(
            "@cognitive/llm-inference",
            {
              ...(resolved.parameter ?? {}),
              model: resolved.model,
              messages: [{ role: "user", content: "请回复两个字：正常" }],
              max_tokens: 16,
              temperature: 0,
              ...(upstream ? { upstream } : {}),
            },
          );
          const ms = Date.now() - t0;
          if (!r.ok || !r.value) {
            void writeAudit(sessionUserId(req) ?? "unknown", "llm.node.probe", `${probeName} → 失败`);
            json(res, 200, { ok: false, model: resolved.model, baseUrl: resolved.baseUrl, ms, error: String(r.error ?? "调用失败（检查上游可达性与密钥）") });
            return;
          }
          void writeAudit(sessionUserId(req) ?? "unknown", "llm.node.probe", `${probeName} → ok ${ms}ms`);
          json(res, 200, {
            ok: true, model: resolved.model, baseUrl: resolved.baseUrl, ms,
            finishReason: r.value.finish_reason,
            sample: (r.value.text ?? "").slice(0, 80),
            usage: r.value.usage,
          });
        } catch (e) {
          json(res, 200, { ok: false, error: String(e) });
        }
        return;
      }
      if (path === "/api/aigility/llm/nodes" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        if (!(await llmAdminGate())) { json(res, 403, { ok: false, error: "需要 model:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; description?: string; serviceModule?: string; functionName?: string; modelName?: string; parameter?: Record<string, unknown>; providerId?: number; isStream?: boolean; enabled?: boolean };
        if (!body.name?.trim() || !body.modelName?.trim() || !body.providerId) {
          json(res, 400, { ok: false, error: "需要 name、modelName 与 providerId" });
          return;
        }
        await ensureLlmNodeReady();
        try {
          const node = await llmNodeStore.createNode({
            name: body.name.trim(), description: body.description ?? "", serviceModule: body.serviceModule ?? "",
            functionName: body.functionName ?? "", modelName: body.modelName.trim(),
            parameter: body.parameter ?? {}, providerId: body.providerId, isStream: body.isStream ?? true, enabled: body.enabled ?? true,
          });
          void writeAudit(sessionUserId(req) ?? "unknown", "llm.node.create", node.name);
          json(res, 200, { ok: true, node });
        } catch (e) { json(res, 400, { ok: false, error: `创建失败（name 重复?）: ${e}` }); }
        return;
      }
      const llmNodePut = path.match(/^\/api\/aigility\/llm\/nodes\/([\d]+)$/);
      if (llmNodePut && req.method === "PUT") {
        if (!requireUser(req, res)) return;
        if (!(await llmAdminGate())) { json(res, 403, { ok: false, error: "需要 model:manage 权限" }); return; }
        const body = JSON.parse((await readBody(req)) || "{}") as { description?: string; serviceModule?: string; functionName?: string; modelName?: string; parameter?: Record<string, unknown>; providerId?: number; isStream?: boolean; enabled?: boolean };
        await llmNodeStore.updateNode(Number(llmNodePut[1]), body);
        void writeAudit(sessionUserId(req) ?? "unknown", "llm.node.update", llmNodePut[1]);
        json(res, 200, { ok: true });
        return;
      }
      const llmNodeDel = path.match(/^\/api\/aigility\/llm\/nodes\/([\d]+)$/);
      if (llmNodeDel && req.method === "DELETE") {
        if (!requireUser(req, res)) return;
        if (!(await llmAdminGate())) { json(res, 403, { ok: false, error: "需要 model:manage 权限" }); return; }
        await llmNodeStore.deleteNode(Number(llmNodeDel[1]));
        void writeAudit(sessionUserId(req) ?? "unknown", "llm.node.delete", llmNodeDel[1]);
        json(res, 200, { ok: true });
        return;
      }
      // ── 角色包（role-kit 双层）：底座模板（packages/role-kit/roles，只读分发）
      //    + 站点事实源（data/roles，工厂编辑写这里）。编辑公共角色 = copy-on-override 站点化。──
      if (path === "/api/aigility/role-packages" && req.method === "GET") {
        // 统一角色列表：角色包（双层）× 发布账本 × 引擎人格注册表 → origin 生命周期分类
        // 可见性纪律：仅自己 的发布仅发布者（或管理员）在账本可见；被隐藏者的角色包卡一并隐藏
        const rpUid = sessionUserId(req);
        const rpAdmin = rpUid ? await isUserAdmin(rpUid) : false;
        const rpViewer = await emailById(rpUid ?? "") ?? "";
        const canSeeSkill = (sk: AigilitySkill) =>
          sk.visibility !== "仅自己" || rpAdmin || (sk.owner ?? "admin@aigility.local") === rpViewer;
        const allSkills = listSkills();
        const ledger = new Map(allSkills.filter(canSeeSkill).map((sk) => [sk.id, sk]));
        const hiddenSkillIds = new Set(allSkills.filter((sk) => !canSeeSkill(sk)).map((sk) => sk.id));
        const pkgs = loadRolePackages({ publicDir: bundledRolesDir(), siteDirs: [SITE_ROLES_DIR] }).filter((p) => !hiddenSkillIds.has(p.id));
        const personaById = new Map(personas.map((pe) => [pe.personaId.replace("@persona/", ""), pe]));
        const packages: Record<string, unknown>[] = pkgs.map((p) => {
          const pub = ledger.get(p.id);
          const isEngine = personaById.has(p.id);
          const pe = personaById.get(p.id);
          const origin = pub ? "published" : p.layer === "site" ? "site" : isEngine ? "engine" : "template";
          return {
            id: p.id, layer: p.layer, dir: p.dir, name: p.name,
            description: p.description, prompt: p.prompt, manifest: p.manifest,
            issues: validateRoleManifest(p.manifest),
            origin, virtual: false,
            ...(pub ? { published: { category: pub.category, tags: pub.tags, modelId: pub.modelId, visibility: pub.visibility, owner: pub.owner ?? null } } : {}),
            ...(isEngine && pe ? { personaRoute: pe.route, personaDesc: pe.desc } : {}),
          };
        });
        // 引擎原生但尚未包化 → 虚拟卡（工厂可见，可「定制副本」站点化）
        for (const [pid, pe] of personaById) {
          if (pkgs.some((x) => x.id === pid)) continue;
          packages.push({
            id: pid, layer: "public", dir: "", name: pe.name, description: pe.desc,
            prompt: "",
            manifest: { role_id: pid, identity: { name: pe.name, capability_ref: pid }, sources: {}, actions: {}, outbound: {}, memory: { agent_id: pid } },
            issues: [], origin: "engine", virtual: true, personaRoute: pe.route, personaDesc: pe.desc,
          });
        }
        json(res, 200, { ok: true, packages });
        return;
      }
      const rolePkgPut = path.match(/^\/api\/aigility\/role-packages\/([\w-]+)$/);
      if (rolePkgPut && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}") as { manifest?: RoleManifest; prompt?: string };
        const pkg = loadRolePackage(rolePkgPut[1], { publicDir: bundledRolesDir(), siteDirs: [SITE_ROLES_DIR] });
        if (!body.manifest) { json(res, 400, { ok: false, error: "缺 manifest" }); return; }
        if (body.manifest.role_id !== rolePkgPut[1]) {
          json(res, 400, { ok: false, error: `role_id 不匹配（${body.manifest.role_id} ≠ ${rolePkgPut[1]}），角色 id 不可改名` });
          return;
        }
        const issues = validateRoleManifest(body.manifest);
        if (issues.length) { json(res, 400, { ok: false, error: issues.join("；") }); return; }
        // M-B 应用级校验（copy-on-override 写入前）：站点副本以"站点优先"压掉出厂模板，
        // 故存根/退化副本必须在落盘前拦下（sales-chat 存根坑即历史实例）。
        // 仅在"实际写入正文"时校验：不传 prompt（只改编排字段）视为保留原人设，放行。
        if (typeof body.prompt === "string" && body.prompt.trim()) {
          // 出厂模板正文：同 id 公共角色存在时用于"非退化"比对（站点已是事实源时不比对）
          const tplPkg = loadRolePackage(rolePkgPut[1], { publicDir: bundledRolesDir(), siteDirs: [] });
          const val = validateSitePersona(body.prompt, tplPkg?.prompt);
          if (!val.ok) { json(res, 400, { ok: false, error: val.issues.join("；"), issues: val.issues }); return; }
        }
        // 不存在的包 = 工厂角色首次声明 → 直接创建站点包（data/roles/<id>，含生成的 SKILL.md 存根）
        let targetDir: string;
        let siteOverride = false;
        let created = false;
        try {
          if (!pkg) {
            targetDir = join(SITE_ROLES_DIR, rolePkgPut[1]);
            mkdirSync(targetDir, { recursive: true });
            const fmName = body.manifest.identity?.name || rolePkgPut[1];
            const fmDesc = body.manifest.identity?.signature || "站点角色（工厂声明创建）";
            const stub = `---\nname: ${fmName}\ndescription: ${fmDesc}\n---\n\n（人设待补：在智能体工厂「人设」区编辑后保存）\n`;
            writeFileSync(`${targetDir}/SKILL.md`, body.prompt?.trim() ? `${body.prompt.trim()}\n` : stub, "utf8");
            created = true;
          } else {
            // copy-on-override：公共模板只读，编辑即复制到站点层（data/roles/<id>）成为站点定制版
            targetDir = pkg.dir;
            if (pkg.layer === "public") {
              targetDir = join(SITE_ROLES_DIR, pkg.id);
              mkdirSync(SITE_ROLES_DIR, { recursive: true });
              rmSync(targetDir, { recursive: true, force: true });
              cpSync(pkg.dir, targetDir, { recursive: true });
              siteOverride = true;
            }
          }
          writePackageFiles(targetDir, body.manifest, typeof body.prompt === "string" ? body.prompt : undefined, Boolean(pkg) && !created);
        } catch (err) {
          json(res, 500, { ok: false, error: `写回失败: ${err}` });
          return;
        }
        void writeAudit(sessionUserId(req) ?? "unknown", "role-package.upsert", rolePkgPut[1],
          `commands=${(body.manifest.actions.commands ?? []).length} schedules=${(body.manifest.actions.schedules ?? []).length}${created ? " · 创建站点包" : ""}${siteOverride ? " · 站点化" : ""}`);
        json(res, 200, { ok: true, siteOverride, created, dir: targetDir });
        return;
      }
      const rolePkgEliza = path.match(/^\/api\/aigility\/role-packages\/([\w-]+)\/eliza$/);
      if (rolePkgEliza && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const pkg = loadRolePackage(rolePkgEliza[1], { publicDir: bundledRolesDir(), siteDirs: [SITE_ROLES_DIR] });
        if (!pkg) { json(res, 404, { ok: false, error: "角色包不存在" }); return; }
        json(res, 200, { ok: true, character: toElizaCharacter({ id: pkg.id, name: pkg.name, description: pkg.description, prompt: pkg.prompt, manifest: pkg.manifest }) });
        return;
      }
      if (path === "/api/aigility/role-packages/import-eliza" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const body = JSON.parse((await readBody(req)) || "{}") as { character?: Record<string, unknown> };
        const char = body.character ?? (body as Record<string, unknown>);
        const r = fromElizaCharacter(char);
        if (!r) { json(res, 400, { ok: false, error: "不是合法的 ElizaOS character file（缺 name）" }); return; }
        const issues = validateRoleManifest(r.manifest);
        if (issues.length) { json(res, 400, { ok: false, error: issues.join("；") }); return; }
        const existing = loadRolePackage(r.manifest.role_id, { publicDir: bundledRolesDir(), siteDirs: [SITE_ROLES_DIR] });
        // M-B 同款校验：导入也是"写站点副本"，退化/存根同样要拦（无 prompt 视为仅声明，放行）
        if (r.prompt.trim()) {
          const tplPkg = loadRolePackage(r.manifest.role_id, { publicDir: bundledRolesDir(), siteDirs: [] });
          const val = validateSitePersona(r.prompt, tplPkg?.prompt);
          if (!val.ok) { json(res, 400, { ok: false, error: val.issues.join("；"), issues: val.issues }); return; }
        }
        const targetDir = existing && existing.layer === "site" ? existing.dir : join(SITE_ROLES_DIR, r.manifest.role_id);
        try {
          mkdirSync(targetDir, { recursive: true });
          writePackageFiles(targetDir, r.manifest, r.prompt, Boolean(existing && existing.layer === "site"));
        } catch (err) {
          json(res, 500, { ok: false, error: `写回失败: ${err}` });
          return;
        }
        void writeAudit(sessionUserId(req) ?? "unknown", "role-package.import-eliza", r.manifest.role_id);
        json(res, 200, { ok: true, id: r.manifest.role_id });
        return;
      }
      const rolePkgDel = path.match(/^\/api\/aigility\/role-packages\/([\w-]+)$/);
      if (rolePkgDel && req.method === "DELETE") {
        // 恢复出厂 = 删除站点定制版，解析自动回落底座模板
        const siteDir = join(SITE_ROLES_DIR, rolePkgDel[1]);
        if (!existsSync(siteDir)) { json(res, 404, { ok: false, error: "无站点定制版可恢复" }); return; }
        rmSync(siteDir, { recursive: true, force: true });
        void writeAudit(sessionUserId(req) ?? "unknown", "role-package.revert", rolePkgDel[1]);
        json(res, 200, { ok: true });
        return;
      }
      const rolePkgPromote = path.match(/^\/api\/aigility\/role-packages\/([\w-]+)\/promote$/);
      if (rolePkgPromote && req.method === "POST") {
        // M-C 提升回流（站点 → 出厂模板）：权限 isAdmin + 非退化校验 + 审计。
        // 动作 = 把站点副本正文写回 packages/role-kit/roles/<id>/SKILL.md（工作区未提交），
        // 由维护者 git diff 审阅后走 PR 合入、随版本分发所有站点（§5-2 负责人拍板）。
        const uid = requireUser(req, res);
        if (!uid) return;
        if (!(await isUserAdmin(uid))) {
          json(res, 403, { ok: false, error: "仅平台管理员可提升为出厂模板" });
          return;
        }
        const sitePkg = loadRolePackage(rolePkgPromote[1], { publicDir: bundledRolesDir(), siteDirs: [SITE_ROLES_DIR] });
        if (!sitePkg || sitePkg.layer !== "site") {
          json(res, 400, { ok: false, error: "仅站点定制版可提升（公共模板本身已是出厂模板）" });
          return;
        }
        // 出厂模板原文（含 frontmatter）：同 id 公共角色存在时用于"非退化"比对与 frontmatter 复用
        const tplPkg = loadRolePackage(rolePkgPromote[1], { publicDir: bundledRolesDir(), siteDirs: [] });
        const tplSkillMd = tplPkg && fileExists(join(tplPkg.dir, "SKILL.md"))
          ? readFileSync(join(tplPkg.dir, "SKILL.md"), "utf8")
          : undefined;
        const built = buildPromotion(sitePkg.id, sitePkg.prompt, tplSkillMd, bundledRolesDir());
        if (!built.ok) { json(res, 400, { ok: false, error: built.issues.join("；"), issues: built.issues }); return; }
        const { promotion } = built;
        try {
          mkdirSync(dirname(promotion.target), { recursive: true });
          const tmp = `${promotion.target}.promote-tmp`;
          writeFileSync(tmp, promotion.content, "utf8");
          renameSync(tmp, promotion.target);
        } catch (err) {
          json(res, 500, { ok: false, error: `写回出厂模板失败: ${err}` });
          return;
        }
        void writeAudit(uid, "role.promote", promotion.roleId,
          `${promotion.bodyLength} 字符 → ${promotion.target}（未提交，待 git PR 人审）`);
        json(res, 200, {
          ok: true,
          target: promotion.target,
          bodyLength: promotion.bodyLength,
          note: "已写回出厂模板（工作区未提交）。请在仓库执行 git diff 审阅后走 PR 合入，合入后随版本分发所有站点。",
        });
        return;
      }
      // ── 模块装配（真 · app_modules/app_module_presets 持久化, 设计见 docs/platform-module-plugin-design.md）──
      if (path === "/api/aigility/modules" && req.method === "GET") {
        const uid = sessionUserId(req);
        // 导航可见偏好（per-user · user_module_nav）：未登录只给默认集
        const navHidden = uid ? await listNavHidden(uid) : Object.fromEntries(
          ["team-memory", "log-monitor"].map((id) => [id, true]));
        json(res, 200, { ok: true, state: await listModuleState(), presets: await listModulePresets(), navHidden });
        return;
      }
      if (path === "/api/aigility/modules/presets" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; enabledIds?: string[] };
        if (!body.name?.trim()) { json(res, 400, { error: "预设需要名称" }); return; }
        const actor = sessionUserId(req) ?? "unknown";
        const ids = Array.isArray(body.enabledIds)
          ? body.enabledIds
          : Object.entries(await listModuleState()).filter(([, v]) => v).map(([k]) => k);
        const preset = await saveModulePreset(body.name.trim(), ids, actor);
        void writeAudit(actor, "preset.save", preset.id, `${preset.name}（${ids.length} 个模块）`);
        json(res, 200, { ok: true, preset });
        return;
      }
      const presetApply = path.match(/^\/api\/aigility\/modules\/presets\/([\w-]+)\/apply$/);
      if (presetApply && req.method === "POST") {
        const actor = sessionUserId(req) ?? "unknown";
        const changed = await applyModulePreset(presetApply[1], actor);
        void writeAudit(actor, "preset.apply", presetApply[1], `${changed} 个模块`);
        json(res, 200, { ok: true, state: await listModuleState() });
        return;
      }
      const presetDel = path.match(/^\/api\/aigility\/modules\/presets\/([\w-]+)$/);
      if (presetDel && req.method === "DELETE") {
        const ok = await deleteModulePreset(presetDel[1]);
        if (!ok) { json(res, 400, { error: "预设不存在或为内置预设" }); return; }
        void writeAudit(sessionUserId(req) ?? "unknown", "preset.delete", presetDel[1]);
        json(res, 200, { ok: true });
        return;
      }
      const moduleToggle = path.match(/^\/api\/aigility\/modules\/([\w-]+)$/);
      if (moduleToggle && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}") as { enabled?: boolean };
        const actor = sessionUserId(req) ?? "unknown";
        const err = await setModuleState(moduleToggle[1], !!body.enabled, actor);
        if (err) { json(res, 400, { error: err }); return; }
        void writeAudit(actor, "module.toggle", moduleToggle[1], body.enabled ? "开" : "关");
        json(res, 200, { ok: true });
        return;
      }
      // 导航可见偏好（per-user · user_module_nav；切换入 audit_log）
      // 权限（现阶段约定，RBAC 模块就绪前以 users.is_admin 判定）：
      //   普通用户不可自行修改布局；管理员可修改任意成员（含自己）的偏好。
      const navToggle = path.match(/^\/api\/aigility\/modules\/([\w-]+)\/nav$/);
      if (navToggle && req.method === "PUT") {
        const body = JSON.parse((await readBody(req)) || "{}") as { hidden?: boolean; userId?: string };
        const actor = sessionUserId(req);
        if (!actor) { json(res, 401, { error: "需要登录" }); return; }
        if (!(await isUserAdmin(actor))) { json(res, 403, { error: "布局由管理员统一配置，普通用户不可修改" }); return; }
        const target = typeof body.userId === "string" && body.userId && body.userId !== actor ? body.userId : actor;
        const err = await setNavHidden(target, navToggle[1], !!body.hidden);
        if (err) { json(res, 400, { error: err }); return; }
        const targetLabel = target !== actor ? ` · 目标 ${await emailById(target) ?? target}` : "";
        void writeAudit(actor, "module.nav", navToggle[1], `${body.hidden ? "隐藏" : "显示"}${targetLabel}`);
        json(res, 200, { ok: true, navHidden: await listNavHidden(target) });
        return;
      }
      // 管理员视图：全部成员的导航偏好（逐用户调整用；非管理员 403）
      if (path === "/api/aigility/nav-prefs" && req.method === "GET") {
        const actor = sessionUserId(req);
        if (!actor) { json(res, 401, { error: "需要登录" }); return; }
        if (!(await isUserAdmin(actor))) { json(res, 403, { error: "仅管理员可查看成员导航偏好" }); return; }
        json(res, 200, { ok: true, prefs: await listNavPrefs() });
        return;
      }

      // ── 工具插件安装（真 · dsh_plugins 注册表 + dsh-host 热装卸, 安装即用免重启）──
      // 社区插件发现（真 · npm registry 检索 dsh-plugin 生态; NPM_REGISTRY_URL 可换镜像, 缺省官方源）
      if (path === "/api/aigility/plugins/discover" && req.method === "GET") {
        const q = new URL(req.url ?? "/", "http://x").searchParams.get("q")?.trim() || "dsh-plugin";
        const registry = process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org";
        try {
          const r = await fetch(`${registry}/-/v1/search?text=${encodeURIComponent(q)}&size=30`, { signal: AbortSignal.timeout(8000) });
          const j = await r.json() as {
            objects?: Array<{ package: { name: string; version: string; description?: string; date?: string; links?: Record<string, string>; keywords?: string[] } }>;
          };
          const items = (j.objects ?? [])
            .map((o) => ({
              name: o.package.name,
              version: o.package.version,
              description: o.package.description ?? "",
              date: o.package.date ?? "",
              repo: o.package.links?.repository ?? "",
              npm: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
              keywords: o.package.keywords ?? [],
            }))
            .filter((p) =>
              /dsh/i.test(p.name) ||
              p.keywords.some((k) => /dsh/i.test(k)) ||
              /deepseek harness|\bdsh\b/i.test(p.description))
            .sort((a, b) => (a.date < b.date ? 1 : -1));
          json(res, 200, { ok: true, registry, items });
        } catch (err) {
          json(res, 200, { ok: false, items: [], error: `registry 不可达: ${String(err)}` });
        }
        return;
      }
      if (path === "/api/aigility/plugins" && req.method === "GET") {
        const rows = await listDshPluginRows();
        const status = dshStatus();
        // runtime 只取 at/error：dshStatus 原始条目含 cordis 句柄（循环引用），直接序列化会炸进程
        json(res, 200, {
          ok: true,
          plugins: rows.map((p) => {
            const rt = (status.plugins[p.name] ?? {}) as { at?: string; error?: string };
            return { ...p, runtime: { at: rt.at, error: rt.error } };
          }),
        });
        return;
      }
      if (path === "/api/aigility/plugins" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          name?: string; package?: string; exportName?: string; description?: string;
          config?: Record<string, unknown>; enable?: boolean;
        };
        if (!body.name?.trim() || !body.package?.trim()) {
          json(res, 400, { error: "安装至少需要插件名与包名" });
          return;
        }
        const rec: DshPluginRow = {
          name: body.name.trim(), package: body.package.trim(), exportName: body.exportName?.trim() ?? "",
          description: body.description?.trim() ?? "", config: body.config ?? {},
        };
        const dup = await insertDshPlugin(rec);
        if (dup) { json(res, 400, { error: dup }); return; }
        const loaded = body.enable !== false
          ? await dshLoadPlugin({ name: rec.name, package: rec.package, export_name: rec.exportName, config: rec.config })
          : { ok: true as const };
        void writeAudit(sessionUserId(req) ?? "unknown", "plugin.install", rec.name,
          `${rec.package} · ${loaded.ok ? "热装载成功" : `装载失败: ${loaded.error ?? "?"}`}`);
        json(res, 200, { ok: true, loaded: loaded.ok, error: loaded.error });
        return;
      }
      const pluginName = path.match(/^\/api\/aigility\/plugins\/([^/]+)$/);
      if (pluginName && req.method === "PUT") {
        const name = decodeURIComponent(pluginName[1]);
        const body = JSON.parse((await readBody(req)) || "{}") as { enabled?: boolean };
        const enable = !!body.enabled;
        if (!enable && (name === "system-prompt" || name === "tools")) {
          json(res, 400, { error: `${name} 是平台关键插件, 不可停用` });
          return;
        }
        const rows = await listDshPluginRows();
        const rec = rows.find((p) => p.name === name);
        if (!rec) { json(res, 404, { error: `插件 ${name} 不存在` }); return; }
        await setDshPluginEnabled(name, enable);
        const r = enable
          ? await dshLoadPlugin({ name: rec.name, package: rec.package, export_name: rec.exportName, config: rec.config })
          : { ok: true, error: undefined as string | undefined };
        if (!enable) {
          const rest = rows.filter((p) => p.enabled && p.name !== name)
            .map((p) => ({ name: p.name, package: p.package, export_name: p.exportName, config: p.config }));
          const results = await dshUnloadPlugin(name, rest);
          r.ok = !results[name]?.error;
          r.error = results[name]?.error;
        }
        void writeAudit(sessionUserId(req) ?? "unknown", "plugin.toggle", name,
          `${enable ? "开" : "关"}${r.ok ? "" : `（失败: ${r.error ?? "?"}）`}`);
        json(res, 200, { ok: true, loaded: r.ok, error: r.error });
        return;
      }
      if (pluginName && req.method === "DELETE") {
        const name = decodeURIComponent(pluginName[1]);
        if (name === "system-prompt" || name === "tools") {
          json(res, 400, { error: `${name} 是平台关键插件, 不可卸载` });
          return;
        }
        const rows = await listDshPluginRows();
        const rest = rows.filter((p) => p.enabled && p.name !== name)
          .map((p) => ({ name: p.name, package: p.package, export_name: p.exportName, config: p.config }));
        await dshUnloadPlugin(name, rest);
        const ok = await deleteDshPluginRow(name);
        if (!ok) { json(res, 404, { error: `插件 ${name} 不存在` }); return; }
        void writeAudit(sessionUserId(req) ?? "unknown", "plugin.uninstall", name);
        json(res, 200, { ok: true });
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
        // 文档生成器（真）：D3 @action/doc-worker，结构化块 → 服务端 docx base64
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
      if (path === "/api/aigility/fde/ledger" && req.method === "GET") {
        // FDE 生意台账（真，@action/fde-ledger 域包）：共库直读 fde-workbench 台账总览
        const r = await seamCall("@action/fde-ledger", { action: "summary" });
        json(res, 200, r.ok ? r.value : { ok: false, error: String(r.error ?? "fde-ledger 调用失败") });
        return;
      }
      if (path === "/api/aigility/fde/proposal-doc" && req.method === "POST") {
        // FDE 方案 DOCX 导出（真）：@action/fde-ledger 组块 → D3 @action/doc-worker
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { proposalId?: string };
          if (!body.proposalId?.trim()) {
            json(res, 400, { ok: false, error: "proposalId 必填" });
            return;
          }
          const r = await seamCall("@action/fde-ledger", { action: "proposal-doc", proposalId: body.proposalId.trim() });
          json(res, 200, r.ok ? (r.value as object) : { ok: false, error: String(r.error ?? "fde-ledger 调用失败") });
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
      // ── 项目小助理（feishu-task-loop）管理：启停 / 状态 / 配置 / 日志 ──
      // 数据面工作流（chat-briefing.yaml）：可视化编辑的读写端点。
      // 该文件即功能开关面板：机器人每次触发前重读，保存即生效无需重启。
      const TASK_LOOP_WF = resolve(process.env.TASK_LOOP_WORKFLOW_FILE || join(REPO_ROOT, "examples/feishu-task-loop/workflows/chat-briefing.yaml"));
      if (path === "/api/aigility/task-loop/workflow" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        if (!fileExists(TASK_LOOP_WF)) { json(res, 404, { ok: false, error: "工作流文件缺失" }); return; }
        json(res, 200, { ok: true, path: TASK_LOOP_WF, yaml: readFileSync(TASK_LOOP_WF, "utf8") });
        return;
      }
      if (path === "/api/aigility/task-loop/workflow" && req.method === "PUT") {
        if (!requireUser(req, res)) return;
        const body = JSON.parse((await readBody(req)) || "{}") as { yaml?: string };
        const text = body.yaml ?? "";
        // 写前校验：能解析 + 结构最低限度（workflow.nodes 非空 Map）——坏文件不落盘
        try {
          const { parse: parseYaml } = await import("yaml");
          const doc = parseYaml(text) as { workflow?: { nodes?: Record<string, unknown> } } | null;
          if (!doc?.workflow || typeof doc.workflow.nodes !== "object" || !doc.workflow.nodes || !Object.keys(doc.workflow.nodes).length) {
            json(res, 400, { ok: false, error: "YAML 校验失败：需含 workflow.nodes 且至少一个节点" });
            return;
          }
        } catch (e) {
          json(res, 400, { ok: false, error: `YAML 解析失败: ${e instanceof Error ? e.message.split("\n")[0] : e}` });
          return;
        }
        try {
          const tmp = `${TASK_LOOP_WF}.tmp`;
          writeFileSync(tmp, text, "utf8");
          renameSync(tmp, TASK_LOOP_WF);
        } catch (err) {
          json(res, 500, { ok: false, error: `写回失败: ${err}` });
          return;
        }
        void writeAudit(sessionUserId(req) ?? "unknown", "task-loop.workflow.put", "chat-briefing", `${text.length} 字节`);
        json(res, 200, { ok: true, hint: "机器人每次触发前重读本文件，保存即生效（无需重启）" });
        return;
      }
      if (path === "/api/aigility/task-loop/status" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "30", 10) || 30;
        const s = taskLoopStatus(Math.min(200, Math.max(1, tail)));
        json(res, 200, { ok: true, status: { ...s, config: taskLoopConfigView(s.config) } });
        return;
      }
      if (path === "/api/aigility/task-loop/board" && req.method === "GET") {
        // 任务看板（使用界面）：聚合仓库池内的 Gitea 工单（待派发/执行中/已完成）
        if (!requireUser(req, res)) return;
        try {
          const board = await fetchTaskLoopBoard();
          json(res, 200, { ok: true, ...board });
        } catch (err) {
          json(res, 200, { ok: false, repos: [], issues: [], errors: [String(err)] });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/start" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          const r = await startTaskLoop();
          json(res, r.ok ? 200 : 409, { ...r });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/stop" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          const r = await stopTaskLoop();
          json(res, r.ok ? 200 : 500, { ...r });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/restart" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          const r = await restartTaskLoop();
          json(res, r.ok ? 200 : 409, { ...r });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/config" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        json(res, 200, { ok: true, config: taskLoopConfigView(loadTaskLoopConfig()) });
        return;
      }
      if (path === "/api/aigility/task-loop/config" && req.method === "PUT") {
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const config = saveTaskLoopConfig(body);
          json(res, 200, { ok: true, config, note: "配置已保存；运行中的进程不热加载，需重启后生效" });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/feishu/chats" && req.method === "POST") {
        // 枚举机器人所在飞书群：凭证用请求体传入（未保存的新 Secret 可先行验证），否则用已保存配置
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { appId?: string; appSecret?: string };
          const r = await listFeishuChats({ appId: body?.appId, appSecret: body?.appSecret });
          json(res, r.ok ? 200 : 400, { ok: r.ok, chats: r.chats, error: r.error });
        } catch (err) {
          json(res, 500, { ok: false, chats: [], error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/task-loop/logs" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "200", 10) || 200;
        json(res, 200, { ok: true, ...taskLoopLogs(tail) });
        return;
      }
      // ── 团队记忆总结（team-memory-console 收编）：状态 / 配置 / 立即生成 / 日志 / 群枚举 ──
      if (path === "/api/aigility/team-memory/status" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "30", 10) || 30;
        const s = teamMemoryStatus(Math.min(200, Math.max(1, tail)));
        json(res, 200, { ok: true, status: { ...s, config: teamMemoryConfigView(s.config) } });
        return;
      }
      if (path === "/api/aigility/team-memory/config" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        json(res, 200, { ok: true, config: teamMemoryConfigView(loadTeamMemoryConfig()) });
        return;
      }
      if (path === "/api/aigility/team-memory/config" && req.method === "PUT") {
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const config = saveTeamMemoryConfig(body);
          json(res, 200, { ok: true, config: teamMemoryConfigView(config), note: "配置已保存；调度按新时刻自动生效（凭证类留空/掩码 = 不修改）" });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/team-memory/run" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { kind?: string };
          const kind = body?.kind === "morning" ? "morning" : "report";
          // 同步等待完成（最长 5 分钟），返回结果与日志尾部
          const r = await runTeamMemoryJob(kind as TeamMemoryJobKind);
          json(res, r.ok ? 200 : 500, { ...r });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/team-memory/logs" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "200", 10) || 200;
        json(res, 200, { ok: true, ...teamMemoryLogs(tail) });
        return;
      }
      if (path === "/api/aigility/team-memory/feishu/chats" && req.method === "POST") {
        // 枚举推送群：凭证用请求体传入（未保存的新 Secret 可先行验证），否则用本模块已保存配置
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { appId?: string; appSecret?: string };
          const r = await listTeamMemoryChats({ appId: body?.appId, appSecret: body?.appSecret });
          json(res, r.ok ? 200 : 400, { ok: r.ok, chats: r.chats, error: r.error });
        } catch (err) {
          json(res, 500, { ok: false, chats: [], error: String(err) });
        }
        return;
      }
      // ── 日志监察员（log-monitor 收编）：状态 / 配置 / 启停 / 日志 ──
      if (path === "/api/aigility/log-monitor/status" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const errs = Number.parseInt(url.searchParams.get("errs") ?? "20", 10) || 20;
        json(res, 200, { ok: true, status: await fetchLogMonitorStatus(Math.min(100, Math.max(1, errs))) });
        return;
      }
      if (path === "/api/aigility/log-monitor/config" && req.method === "PUT") {
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          const config = await saveLogMonitorConfig(body);
          json(res, 200, { ok: true, config, note: "配置已下发给运行中的 daemon（即时生效，开启中的自动化会立即检查一次）" });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/log-monitor/start" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const r = await startLogMonitor();
        json(res, r.ok ? 200 : 500, { ...r });
        return;
      }
      if (path === "/api/aigility/log-monitor/stop" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const r = await stopLogMonitor();
        json(res, r.ok ? 200 : 500, { ...r });
        return;
      }
      if (path === "/api/aigility/log-monitor/restart" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        const r = await restartLogMonitor();
        json(res, r.ok ? 200 : 500, { ...r });
        return;
      }
      if (path === "/api/aigility/log-monitor/logs" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        const url = new URL(req.url ?? "/", "http://x");
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "200", 10) || 200;
        json(res, 200, { ok: true, ...logMonitorLogs(Math.min(1000, Math.max(1, tail))) });
        return;
      }
      // ── 身份对齐（花名册自动匹配 + 审查）：飞书/Gitea/太忆云 三轴同人对齐 ──
      if (path === "/api/aigility/identity/overview" && req.method === "GET") {
        if (!requireUser(req, res)) return;
        try {
          json(res, 200, await identityOverview());
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/identity/auto-match" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          json(res, 200, await runIdentityAutoMatch());
        } catch (err) {
          json(res, 500, { ok: false, error: String(err) });
        }
        return;
      }
      if (path === "/api/aigility/identity/bind" && req.method === "POST") {
        if (!requireUser(req, res)) return;
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as IdentityBindRequest;
          if (!body.memberId || !body.axis || !body.op) {
            json(res, 400, { ok: false, error: "缺少 memberId/axis/op" });
            return;
          }
          const r = identityBind(body);
          json(res, r.ok ? 200 : 400, { ...r });
        } catch (err) {
          json(res, 400, { ok: false, error: String(err) });
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

  // 团队记忆总结调度器（进程内；是否到点触发由配置 enabled 决定）
  startTeamMemoryScheduler();

  // 托管应用自动拉起（config/managed-apps.json；锁文件幂等，平台重启不重复拉起）
  startManagedApps();

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
