/**
 * 企微机器人 → DSH 会话中继 (wecom-dsh)
 *
 * 在企微上与 harness agent 对话: 每条企微消息转发给官方 dsh headless agent
 * （同一套 llm/tools/session/沙箱/skill 服务图），并用 --resume 在同一会话上
 * 多轮续聊。与 Web GUI 共用 DSH_HOME + 工作区时，企微会话出现在 GUI 的
 * 会话历史里 —— 相当于「在企微上开了一个同一环境、记忆独立存续的 agent 窗口」。
 *
 * 运行前准备 (.env 或环境变量):
 *   WECOM_DSH_BOT_ID=xxx          # 企微后台「智能机器人」
 *   WECOM_DSH_BOT_SECRET=xxx
 *   DSH_BIN=D:\\SiteWorkspace\\aigility-harness\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.5-rc.2_...\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js
 *   DSH_HOME=D:\\SiteWorkspace\\aigility-harness\\examples\\.dsh-home
 *   DEEPSEEK_API_KEY=xxx          # headless 上游 (OpenAI 兼容, 可指向 bigmodel 网关)
 *   DEEPSEEK_BASE_URL=https://... # 可选
 *   DSH_PERMISSION_MODE=...       # 可选, 如 read-only
 * 启动: pnpm --filter wecom-dsh start
 *
 * 企微指令:
 *   普通消息            → 转发给 agent（同会话多轮）
 *   /new                → 放弃当前会话，下条消息开新会话
 *   /session            → 查看当前会话 id
 */
import {
  bootstrap,
  shutdown,
  RunMode,
  InProcessScheduler,
  LayerId,
  CarrierKind,
  PluginState,
  ok,
  err,
} from "@aigility-harness/core";
import type {
  KernelConfig,
  ServiceDefinition,
  Provider,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";
import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { plugin as infrastructurePlugin } from "@aigility-harness/layer-infrastructure";
import { wecomIngressProvider } from "@aigility-harness/layer-infrastructure";
import { loadEnv } from "./env.js";
import { dshRun, listSessions, SessionStore } from "./dsh-cli.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");
const STATE_FILE = resolve(__dirname, "../.state/sessions.json");

// ── 会话中继能力（与角色相同的调用契约: {user_input,...} → {response}）──

export const dshRelayRef: CapabilityRef = {
  id: "@infrastructure/dsh-session-relay",
  versionRange: "^1.0.0",
};

export const dshRelayService: ServiceDefinition<{ user_input: string; user_id?: string }, { response: string }> = {
  id: "@infrastructure/dsh-session-relay",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "企微消息 → 官方 dsh headless agent 会话中继（--resume 多轮）",
};

/** 企微 Markdown 长度上限（保守截断，保留尾部结论） */
const MAX_REPLY = 3500;

function createRelayProvider(): Provider<{ user_input: string; user_id?: string }, { response: string }> {
  const dshBinJs = process.env["DSH_BIN"] ?? "";
  const dshHome = process.env["DSH_HOME"] ?? "";
  const cwd = process.env["DSH_CWD"] ?? REPO_ROOT;
  const store = new SessionStore(STATE_FILE);

  const extraEnv: Record<string, string> = {};
  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DSH_PERMISSION_MODE"]) {
    const v = process.env[key];
    if (v) extraEnv[key] = v;
  }

  const run = (task: string, sessionId?: string) =>
    dshRun({ dshBinJs, dshHome, cwd, task, resumeSessionId: sessionId, extraEnv });

  return {
    service: dshRelayService,
    name: "infrastructure-dsh-session-relay",
    state: PluginState.Active,
    async health(): Promise<HealthStatus> {
      return {
        healthy: Boolean(dshBinJs) && Boolean(dshHome),
        detail: dshBinJs ? `dsh=${dshBinJs}` : "DSH_BIN 未配置",
        checkedAt: new Date().toISOString(),
      };
    },
    async execute(request, _ctx: SeamContext): Promise<Result<{ response: string }>> {
      if (!dshBinJs || !dshHome) {
        return err("缺少配置: 请设置 DSH_BIN / DSH_HOME（参考 examples/wecom-dsh/README.md）");
      }
      const text = request.user_input.trim();
      const chatId = (request as { user_id?: string }).user_id ?? "default";

      // 企微侧指令
      if (text === "/new") {
        store.delete(chatId);
        return ok({ response: "✅ 已开启新会话，下条消息将创建全新 agent 会话。" });
      }
      if (text === "/session") {
        const sid = store.get(chatId);
        return ok({ response: sid ? `当前会话: ${sid}` : "尚无会话，下条消息将创建新会话。" });
      }

      const before = new Set(listSessions(dshHome).map((s) => s.id));
      const resumeId = store.get(chatId);
      console.log(`[relay] chat=${chatId} resume=${resumeId ?? "(新会话)"} task=${text.slice(0, 60)}…`);
      const result = await run(text, resumeId);

      if (!result.ok) {
        return ok({ response: `⚠️ agent 执行失败 (${(result.durationMs / 1000).toFixed(0)}s):\n${result.error ?? "未知错误"}` });
      }

      // 首条消息: 从新出现的 session 目录里发现会话 id
      if (!resumeId) {
        const fresh = listSessions(dshHome).filter((s) => !before.has(s.id));
        if (fresh.length > 0) {
          fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
          store.set(chatId, fresh[0].id);
          console.log(`[relay] 新会话已绑定: chat=${chatId} session=${fresh[0].id}`);
        }
      }

      let response = result.output || "(agent 无文本输出)";
      if (response.length > MAX_REPLY) {
        response = response.slice(0, 800) + "\n\n…(中间略)…\n\n" + response.slice(-MAX_REPLY + 800);
      }
      return ok({ response });
    },
  };
}

// ── 装配 ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== 企微机器人 → DSH 会话中继 (wecom-dsh) ===\n");

  loadEnv();
  const botId = process.env["WECOM_DSH_BOT_ID"] ?? "";
  const secret = process.env["WECOM_DSH_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error("缺少凭证: 请在 .env 设置 WECOM_DSH_BOT_ID / WECOM_DSH_BOT_SECRET");
    process.exit(1);
  }
  if (!process.env["DSH_BIN"] || !process.env["DSH_HOME"]) {
    console.error(
      "缺少配置: 请在 .env 设置 DSH_BIN（官方 dsh 的 lib/bin.js 绝对路径）与 DSH_HOME\n" +
        "示例见 examples/wecom-dsh/README.md",
    );
    process.exit(1);
  }

  // 1. 内核（原型模式）+ 装配
  const kernel = new InMemoryKernelAdapter();
  const plugins = [infrastructurePlugin];
  for (const p of plugins) {
    console.log(`装配 ${p.manifest.name} (layer=${p.manifest.layer})`);
  }

  const kernelConfig: KernelConfig = {
    mode: RunMode.Prototype,
    profile: "wecom-dsh",
    autoHotSwap: false,
    healthCheckIntervalMs: 10_000,
  };
  const scheduler = new InProcessScheduler(kernel, kernel.registry);
  const boot = await bootstrap({ kernel, kernelConfig, plugins, scheduler });
  if (!boot.ok) {
    console.error("bootstrap 失败:", boot.error);
    process.exit(1);
  }

  // 2. 注册会话中继能力
  const relay = createRelayProvider();
  const reg = await kernel.registry.register(dshRelayService, relay);
  if (!reg.ok) {
    console.error("dsh-session-relay 注册失败:", reg.error);
    process.exit(1);
  }
  console.log("[relay] @infrastructure/dsh-session-relay 已注册");

  // 3. 启动企业微信入口 → 全部消息路由到会话中继
  const ctx = kernel.createContext("wecom-dsh", LayerId.Infrastructure);
  const start = await wecomIngressProvider.execute(
    {
      botId,
      secret,
      agentRoutes: { "*": "@infrastructure/dsh-session-relay" },
      perceptionId: "@infrastructure/dsh-session-relay",
      thinkingText: "🤖 agent 正在处理…",
    },
    ctx,
  );
  if (!start.ok) {
    console.error("wecom-ingress 启动失败:", start.error);
    process.exit(1);
  }
  const wsInfo = start.value;
  console.log(`\n✅ 企业微信机器人已连接 (botId=${wsInfo.botId})`);
  console.log(`   DSH_HOME=${process.env["DSH_HOME"]}`);
  console.log(`   工作区=${process.env["DSH_CWD"] ?? REPO_ROOT}`);
  console.log("   在企微里 @机器人 说话即可与 harness agent 对话; /new 开新会话\n");

  // 4. 等待退出
  const stopWs = async () => {
    await wsInfo.stop();
    await shutdown(kernel, scheduler);
    process.exit(0);
  };
  process.on("SIGINT", () => void stopWs());
  process.on("SIGTERM", () => void stopWs());
  console.log("按 Ctrl+C 退出");
}

main().catch((e) => {
  console.error("启动异常:", e);
  process.exit(1);
});
