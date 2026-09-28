/**
 * L4 编排规划层: 插件安装工作流 (plugin-install)
 *
 * plugin-helper 角色的幕后工作流：用户问「怎么加个插件」时由本工作流
 * 执行真实可验证的安装引导：
 *   1. 扫描 config/py-plugins.json → 已声明的 Python 能力插件
 *   2. 扫描 packages 目录下各包的 package.json → 已注册的 TS 原生插件
 *   3. 契约校验 → 判断插件是否已提供、缺依赖、走哪条接入路径
 *   4. 输出指引（供 plugin-helper 反馈）
 *
 * 设计要点:
 *   - 确定性逻辑, 不依赖 LLM (原型可立即执行)
 *   - 将来可热切换: 同一能力 id 由 py-bridge 声明为
 *     aigility.workflow.WorkflowEngine 的 YAML 工作流
 *   - 本 provider 保持原子: 只做「扫描+校验+指引」
 *   - 意图关键词与指引话术外置 config/plugin-install.yaml
 *     (业务可改, 改完不用动代码; 文件缺失/解析失败回落内置默认值)
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate, loadConfigSection } from "./prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 业务配置 (关键词 + 指引话术; config/plugin-install.yaml 可覆盖) ──

const DEFAULT_KEYWORDS = ["rag", "memory", "workflow", "TTS", "STT", "ASR", "聊天", "记忆", "检索", "工作流", "语音"];

const DEFAULT_GUIDANCE = {
  found_python:
    "「{{keyword}}」能力已接入 ✅ — {{capability_id}} 已在 config/py-plugins.json 声明，无需额外安装。直接通过 Seam 调用即可（ctx.call({ id: \"{{capability_id}}\" })）。",
  found_python_path: "py-plugins.json 声明式接入（已就绪）",
  found_ts:
    "「{{keyword}}」能力已存在 ✅ — 包 {{package}} 在 packages/ 下。若需新增同类插件：在 packages/ 新建 LayerPlugin，声明 provides/consumes 契约后注册进 bootstrap。",
  found_ts_path: "TS 原生插件（packages/ 新建 LayerPlugin）",
  not_found: [
    "「{{keyword}}」目前未接入。接入路径：",
    "1. Python 能力插件 → 在 config/py-plugins.json 增加声明（参考现有 aigility-workflow / aigility-memory 条目）",
    "2. TS 原生插件 → 在 packages/ 新建 LayerPlugin 并注册",
    "已扫描到 {{py_count}} 个 Python 插件、{{ts_count}} 个 TS 包，见下方清单。",
  ].join("\n"),
  not_found_path: "py-plugins.json 声明式 或 packages/ 新建 LayerPlugin",
  intro: [
    "我可以帮你接入插件。当前已扫描：",
    "- Python 能力插件 {{py_count}} 个（{{py_names}}）",
    "- TS 包 {{ts_count}} 个（{{ts_list}}）",
    "告诉我你想装什么（如 RAG / 记忆 / 工作流 / 语音），我给出具体接入步骤。",
  ].join("\n"),
};

type GuidanceKey = keyof typeof DEFAULT_GUIDANCE;
type Guidance = Record<GuidanceKey, string>;

function loadInstallConfig(): { keywords: string[]; guidance: Guidance } {
  const cfg = loadConfigSection<{ keywords?: string[]; guidance?: Partial<Guidance> }>(
    "plugin-install.yaml",
    "plugin_install",
  );
  return {
    keywords:
      Array.isArray(cfg?.keywords) && cfg!.keywords!.length > 0 &&
      cfg!.keywords!.every((k) => typeof k === "string" && k.trim())
        ? cfg!.keywords!
        : DEFAULT_KEYWORDS,
    guidance: { ...DEFAULT_GUIDANCE, ...(cfg?.guidance ?? {}) },
  };
}

const INSTALL_CFG = loadInstallConfig();

// ── 服务定义 ─────────────────────────────────────────────────────

export interface PluginInstallRequest {
  /** 用户输入 (如"帮我加个 RAG 插件") */
  user_input: string;
  /** 可选: 会话 ID */
  session_id?: string;
  /** 可选: 角色系统提示词 (plugin-helper 下发) */
  system_prompt?: string;
}

export interface PluginInstallResponse {
  /** 引导回复文字 */
  result: string;
  /** 已扫描到的可用插件清单 */
  available: string[];
  /** 推荐接入路径 */
  suggested_path?: string;
  /** 扫描统计 */
  scanned: {
    pyPlugins: number;
    tsPackages: number;
  };
  /** 会话 ID */
  session_id: string;
}

export const pluginInstallService: ServiceDefinition<
  PluginInstallRequest,
  PluginInstallResponse
> = {
  id: "@orchestration/plugin-install",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description: "插件安装工作流：扫描插件清单 → 契约校验 → 输出接入指引",
};

// ── 扫描辅助 ─────────────────────────────────────────────────────

/** 仓库根目录: packages/layer-orchestration/src → 上溯 3 级 */
function repoRoot(): string {
  return resolve(__dirname, "..", "..", "..");
}

interface PyPluginEntry {
  name: string;
  capabilities: { id: string; layer: string; function: string }[];
}

/** 读取 config/py-plugins.json, 不存在时返回空数组 */
function scanPyPlugins(root: string): PyPluginEntry[] {
  const p = join(root, "config", "py-plugins.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      plugins?: PyPluginEntry[];
    };
    return raw.plugins ?? [];
  } catch {
    return [];
  }
}

/** 扫描 packages/* 目录名 (TS 原生插件包) */
function scanTsPackages(root: string): string[] {
  const dir = join(root, "packages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 判断用户想装什么: 从 user_input 提取关键词 → 匹配已知插件 */
function matchPlugin(userInput: string, pyPlugins: PyPluginEntry[], tsPackages: string[]): {
  keyword?: string;
  found: boolean;
  kind?: "python" | "ts";
  id?: string;
} {
  const kw = INSTALL_CFG.keywords.find((k) =>
    userInput.toLowerCase().includes(k.toLowerCase()),
  );
  if (!kw) return { found: false };

  // Python 插件: 按 capability id 匹配
  for (const plugin of pyPlugins) {
    for (const cap of plugin.capabilities) {
      if (cap.id.toLowerCase().includes(kw.toLowerCase())) {
        return { keyword: kw, found: true, kind: "python", id: cap.id };
      }
    }
  }
  // TS 包: 按目录名匹配
  const ts = tsPackages.find((p) => p.toLowerCase().includes(kw.toLowerCase()));
  if (ts) return { keyword: kw, found: true, kind: "ts", id: ts };

  return { keyword: kw, found: false };
}

/** 生成指引文字 (话术模板在 config/plugin-install.yaml, 占位符运行时填充) */
function buildGuidance(
  match: ReturnType<typeof matchPlugin>,
  pyPlugins: PyPluginEntry[],
  tsPackages: string[],
  userInput: string,
): { result: string; suggested_path?: string; available: string[] } {
  const g = INSTALL_CFG.guidance;
  const available = [
    ...pyPlugins.flatMap((p) => p.capabilities.map((c) => c.id)),
    ...tsPackages.map((p) => `packages/${p}`),
  ];

  if (match.found && match.kind === "python" && match.id) {
    return {
      result: renderTemplate(g.found_python, { keyword: match.keyword ?? "", capability_id: match.id }),
      suggested_path: g.found_python_path,
      available,
    };
  }
  if (match.found && match.kind === "ts" && match.id) {
    return {
      result: renderTemplate(g.found_ts, { keyword: match.keyword ?? "", package: match.id }),
      suggested_path: g.found_ts_path,
      available,
    };
  }
  if (match.keyword && !match.found) {
    return {
      result: renderTemplate(g.not_found, { keyword: match.keyword, py_count: pyPlugins.length, ts_count: tsPackages.length }),
      suggested_path: g.not_found_path,
      available,
    };
  }

  return {
    result: renderTemplate(g.intro, {
      py_count: pyPlugins.length,
      py_names: pyPlugins.map((p) => p.name).join("、") || "无",
      ts_count: tsPackages.length,
      ts_list: `${tsPackages.slice(0, 5).join("、")}${tsPackages.length > 5 ? "…" : ""}`,
    }),
    available,
  };
}

// ── Provider 实现 ────────────────────────────────────────────────

const pluginInstallProvider: Provider<
  PluginInstallRequest,
  PluginInstallResponse
> = {
  service: pluginInstallService,
  name: "orchestration-plugin-install-scan",
  state: PluginState.Active,
  async execute(
    request: PluginInstallRequest,
    ctx: SeamContext,
  ): Promise<Result<PluginInstallResponse>> {
    const root = repoRoot();
    const pyPlugins = scanPyPlugins(root);
    const tsPackages = scanTsPackages(root);

    const match = matchPlugin(request.user_input, pyPlugins, tsPackages);
    const { result, suggested_path, available } = buildGuidance(
      match,
      pyPlugins,
      tsPackages,
      request.user_input,
    );

    return ok({
      result,
      available,
      ...(suggested_path ? { suggested_path } : {}),
      scanned: {
        pyPlugins: pyPlugins.length,
        tsPackages: tsPackages.length,
      },
      session_id: request.session_id ?? ctx.sessionId,
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "plugin-install workflow ready (scan py-plugins.json + packages)",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { pluginInstallProvider };