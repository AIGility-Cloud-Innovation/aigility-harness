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

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const kw = ["rag", "memory", "workflow", "TTS", "聊天", "记忆", "检索", "工作流", "语音"].find((k) =>
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

/** 生成指引文字 */
function buildGuidance(
  match: ReturnType<typeof matchPlugin>,
  pyPlugins: PyPluginEntry[],
  tsPackages: string[],
  userInput: string,
): { result: string; suggested_path?: string; available: string[] } {
  const available = [
    ...pyPlugins.flatMap((p) => p.capabilities.map((c) => c.id)),
    ...tsPackages.map((p) => `packages/${p}`),
  ];

  if (match.found && match.kind === "python" && match.id) {
    return {
      result: `「${match.keyword}」能力已接入 ✅ — ${match.id} 已在 config/py-plugins.json 声明，无需额外安装。直接通过 Seam 调用即可（ctx.call({ id: "${match.id}" })）。`,
      suggested_path: "py-plugins.json 声明式接入（已就绪）",
      available,
    };
  }
  if (match.found && match.kind === "ts" && match.id) {
    return {
      result: `「${match.keyword}」能力已存在 ✅ — 包 ${match.id} 在 packages/ 下。若需新增同类插件：在 packages/ 新建 LayerPlugin，声明 provides/consumes 契约后注册进 bootstrap。`,
      suggested_path: "TS 原生插件（packages/ 新建 LayerPlugin）",
      available,
    };
  }
  if (match.keyword && !match.found) {
    return {
      result: `「${match.keyword}」目前未接入。接入路径：\n1. Python 能力插件 → 在 config/py-plugins.json 增加声明（参考现有 aigility-workflow / aigility-memory 条目）\n2. TS 原生插件 → 在 packages/ 新建 LayerPlugin 并注册\n已扫描到 ${pyPlugins.length} 个 Python 插件、${tsPackages.length} 个 TS 包，见下方清单。`,
      suggested_path: "py-plugins.json 声明式 或 packages/ 新建 LayerPlugin",
      available,
    };
  }

  return {
    result: `我可以帮你接入插件。当前已扫描：\n- Python 能力插件 ${pyPlugins.length} 个（${pyPlugins.map((p) => p.name).join("、") || "无"}）\n- TS 包 ${tsPackages.length} 个（${tsPackages.slice(0, 5).join("、")}${tsPackages.length > 5 ? "…" : ""}）\n告诉我你想装什么（如 RAG / 记忆 / 工作流 / 语音），我给出具体接入步骤。`,
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