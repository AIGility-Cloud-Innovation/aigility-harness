/**
 * L3 感知交互层: 网页应用开发员 (app-dev)
 *
 * 与用户「直接沟通」的网页应用开发角色——根据描述生成/修改网页应用，
 * 把生成任务委托给 D5 的 @action/codex-agent 执行真实编码。
 *
 * 设计要点:
 *   - 专注建应用: 用户说「建个记账本」→ codex-agent 生成前端 HTML
 *   - 可操作目录受限: 只能在沙箱根 examples/apps 内生成/修改文件
 *   - 绑定实现 @action/codex-agent (可换底层)
 *
 * 与 coding-coach 的区别: coding-coach 偏「分步引导设计(不动手)」, coder 偏「网页应用
 * 生成/修改」, 且带目录沙箱限制。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import { resolve, sep, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface AppDevRequest {
  /** 用户输入 (如"帮我建个记账本" / "写个排序") */
  user_input: string;
  /** 可选: 工作目录 (默认调用方 cwd) */
  cwd?: string;
  /** 可选: 会话 ID */
  session_id?: string;
  /** 编码驱动 (codex / zcode / claude), 不传用 AGENT_DRIVER 环境变量 */
  driver?: string;
}

export interface AppDevResponse {
  /** 角色反馈文字 (结果/计划/摘要) */
  response: string;
  /** 编码执行的原始结果 (codex-agent 返回) */
  raw?: unknown;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
}

export const appDevService: ServiceDefinition<AppDevRequest, AppDevResponse> = {
  id: "@persona/app-dev",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "网页应用开发员：根据描述生成/修改网页应用（委托 L4 codex-agent + 目录沙箱限制）",
};

/** 委托的 L4 编码 Agent (实现无关; 换 claude-code/opencode 只改这一处) */
export const codexAgentRef: CapabilityRef = {
  id: "@action/codex-agent",
  versionRange: "^1.0.0",
};

/** 各编码 Agent */
const agentRefs: Record<string, CapabilityRef> = {
  zcode: { id: "@action/zcode-agent", versionRange: "^1.0.0" },
  claude: { id: "@action/claude-agent", versionRange: "^1.0.0" },
};

/** 驱动选择: 请求级 driver > 环境变量 AGENT_DRIVER > 默认 codex */
function agentDriverRef(requestDriver?: string): CapabilityRef {
  const drv = requestDriver ?? process.env.AGENT_DRIVER ?? "codex";
  return agentRefs[drv] ?? codexAgentRef;
}

// ── 可操作目录白名单 ──────────────────────────────────────────────
// app-dev 委托 codex-agent 时, 工作目录必须落在允许的沙箱目录内,
// 防止用户让 codex 在任意目录 (如 /home /etc) 写文件/执行命令。

/** 默认沙箱根: examples/apps (应用产物目录)。可从环境变量覆盖。 */
// 从本文件位置推导仓库根: src → layer-persona → packages → 仓库根 (dirname 后上 3 级)
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const DEFAULT_SANDBOX_ROOT = resolve(REPO_ROOT, "examples", "apps");

/** 确保沙箱根存在 (codex 首次执行前必须存在) */
/**
 * 运行后扁平化: 把沙箱子目录里新生的 *.html (如 ZCode 新建项目的 __new__ 约定目录)
 * 移动到沙箱根目录 —— 大厅只伺服根目录的扁平 HTML, 子目录文件必然 404。
 * 重名时追加序号; 清空后删除空子目录。
 */
export function flattenSandboxApps(): string[] {
  const root = ensureSandboxRoot();
  const moved: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return moved; }
  for (const dir of entries) {
    const dirPath = join(root, dir);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith(".html"));
    } catch { continue; }
    for (const f of files) {
      let dest = join(root, f);
      if (existsSync(dest)) {
        const base = f.slice(0, -5);
        let n = 2;
        while (existsSync(join(root, `${base}-${n}.html`))) n++;
        dest = join(root, `${base}-${n}.html`);
      }
      try {
        renameSync(join(dirPath, f), dest);
        moved.push(dest.slice(root.length + 1));
      } catch { /* 单文件失败不影响其余 */ }
    }
    try {
      if (readdirSync(dirPath).length === 0) rmdirSync(dirPath);
    } catch { /* ignore */ }
  }
  if (moved.length > 0) console.log(`[app-dev] 扁平化 ${moved.length} 个应用到沙箱根: ${moved.join(", ")}`);
  return moved;
}

export function ensureSandboxRoot(): string {
  const root = resolve(DEFAULT_SANDBOX_ROOT);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

/** 允许 codex 操作的工作目录白名单 (解析为绝对路径, 防 .. 逃逸) */
export function getAllowedCwd(cwd?: string): string {
  const root = resolve(DEFAULT_SANDBOX_ROOT);
  if (!cwd) return ensureSandboxRoot();
  const target = resolve(root, cwd);
  // 必须位于沙箱根内, 不允许 .. 逃逸到沙箱外
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`工作目录不在允许范围内: ${cwd} (仅允许 ${root} 内)`);
  }
  return target;
}

// ── 角色人设提示词 ────────────────────────────────────────────────

const APP_DEV_SYSTEM_PROMPT = `你是「网页应用开发员」，一位专注的网页应用生成专家。你的核心能力是：根据用户的描述，生成可直接运行的网页应用。

你能帮用户做的事:
1. 创建小型网页应用 (记账本 / TODO 清单 / 班主任小本本 等): 生成自包含、可直接打开的单 HTML 页面
2. 修改已有应用: 用户说「给记账本加个统计」, 你直接改
3. 简单答疑: 应用相关的小问题可以回答, 但核心是生成/修改应用

对话风格:
- 像朋友一样直接沟通: 先理解用户真实意图, 必要时确认关键细节
- 主动: 用户说「建个 X」, 你直接动手生成, 完成后给访问方式
- 简洁: 结论先行, 代码用代码块, 不啰嗦

创建应用的规则:
- 生成自包含的单 HTML 文件 (内嵌 CSS/JS), 可直接浏览器打开
- 有简单的数据存储 (localStorage 或后端 API)
- 页面由 AppBase 同源伺服: 后端 API 一律用相对路径 (空基址), 如 fetch('/app/data/xxx')
- 禁止硬编码 127.0.0.1 / localhost / 内网 IP / 带端口的主机地址 —— 会导致其他设备打开时请求打到设备自身
- 需直连 AI 网关 (端口与本页不同) 时, 用 location.hostname 动态推导: location.protocol + '//' + location.hostname + ':3418'
- 完成后告诉用户: 应用已创建, 如何访问/使用

产出位置 (必须遵守):
- 新建应用必须直接生成在工作目录根部 (如 ./log-monitor.html), 绝对不要创建子目录存放
- 修改已有应用直接改对应 .html 文件本身

工作目录限制 (必须遵守):
- 你只能在你被指定的工作目录内生成/修改文件
- 绝对禁止通过 .. 或绝对路径访问工作目录之外的位置
- 所有产出文件必须落在指定工作目录内

失败处理:
- 如实说明失败原因, 不编造成功结果
- 涉及外部依赖/环境问题时说明前提条件`;

/**
 * 行为约束模板: 固定前缀注入最终 prompt, 防执行漂移
 * (借鉴 timem-project chatgpt_adapter 的 4 条约束 —— 那是 12M tokens 漂移事故换来的教训)
 */
const BEHAVIOR_CONSTRAINTS = `【行为约束（必须遵守）】
1. 只执行用户任务中指定的事项，不要扩大范围、不要顺手改无关内容
2. 只在工作目录及其子目录内读写文件，不访问任务之外的路径
3. 不检查进程列表 / 环境变量 / 系统配置 / 网络端口等与任务无关的系统信息
4. 任务完成即停止，不运行多余的命令、不做多余的验证`;

// ── Provider 实现 ────────────────────────────────────────────────

const appDevProvider: Provider<AppDevRequest, AppDevResponse> = {
  service: appDevService,
  name: "persona-app-dev-text",
  state: PluginState.Active,
  async execute(
    request: AppDevRequest,
    ctx: SeamContext,
  ): Promise<Result<AppDevResponse>> {
    // 1. 角色形象: 网页应用开发员 (驱动可切换: codex / zcode, 按 AGENT_DRIVER 标注)
    const driverName = process.env.AGENT_DRIVER === "zcode" ? "ZCode" : "Codex";
    const agentName = `网页应用开发员 (${driverName} 驱动)`;

    // 2. 校验工作目录在沙箱白名单内 (防任意目录写文件/执行命令)
    let cwd: string;
    try {
      cwd = getAllowedCwd(request.cwd);
    } catch (e) {
      return ok({
        response: `无法执行：${String((e as Error).message)}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }

    // 3. 构建带角色知识的任务 (委托 L4 codex-agent 执行真实编码)
    const task = {
      prompt: `${APP_DEV_SYSTEM_PROMPT}\n\n${BEHAVIOR_CONSTRAINTS}\n\n用户任务:\n${request.user_input}\n\n工作目录: ${cwd}\n`,
      cwd,
      // 规划阶段模型: 跟随 LLM_MODEL (与认知层一致), 避免硬编码不存在的模型
      planningModel: process.env.LLM_MODEL ?? "glm-4.6",
    };

    // 4. 委托 D5 编码 Agent (请求级 driver: codex / zcode / claude)
    const result = await ctx.call(agentDriverRef(request.driver), task);

    // 5. 由同一角色形象反馈
    if (!result.ok) {
      return ok({
        response: `任务未完成：${result.error}`,
        agent_name: agentName,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
      });
    }
    const raw = result.value as { text?: string; plan?: string };
    // 运行后扁平化: 子目录里的新应用 (ZCode __new__ 约定) 移到根目录, 否则大厅看不见
    const moved = flattenSandboxApps();
    const movedNote = moved.length > 0
      ? `

（检测到应用生成在子目录，已自动移入大厅根目录：${moved.join("、")}）`
      : "";
    const response =
      raw?.text && raw.text.length > 0
        ? raw.text + movedNote
        : "任务已完成，但未返回可展示的文本结果。" + movedNote;

    return ok({
      response,
      ...(result.value ? { raw: result.value } : {}),
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "app-dev ready (委托 @action/codex-agent)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { appDevProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/app-dev",
  layer: LayerId.Persona,
  description: "感知层：Codex 对话助手角色形象（直接沟通 + 委托 L4 codex-agent）",
  version: "0.1.0",
  provides: [appDevService],
  consumes: [codexAgentRef],
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
    return [appDevProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};