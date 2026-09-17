/**
 * 企微机器人 → DSH 会话中继 (wecom-dsh)
 *
 * 在企微上与 harness agent 对话: 每条企微消息转发给官方 dsh headless agent
 * （同一套 llm/tools/session/沙箱/skill 服务图）。headless runner 每次调用都
 * 新建会话、无 --resume 续聊能力（dsh-headless 源码即如此），多轮记忆由本
 * 中继自行维护：按聊天保留滚动对话历史，随下一条消息作为上下文注入任务文本。
 *
 * 运行前准备 (examples/wecom-dsh/.env，模板 .env.example):
 *   WECOM_DSH_BOT_ID=xxx          # 企微后台「智能机器人」
 *   WECOM_DSH_BOT_SECRET=xxx
 *   DSH_BIN=D:\\...\\@deepseek-ai\\dsh\\lib\\bin.js
 *   DSH_HOME=D:\\SiteWorkspace\\aigility-harness\\examples\\.dsh-home
 *   DEEPSEEK_API_KEY=xxx          # headless 上游 (OpenAI 兼容, 可指向 bigmodel 网关)
 *   DEEPSEEK_BASE_URL=https://... # 可选
 *   DSH_PERMISSION_MODE=...       # 可选, 如 read-only
 * 启动: pnpm --filter wecom-dsh start
 *
 * 企微指令:
 *   普通消息            → 转发给 agent（滚动上下文多轮）
 *   /new                → 清空当前聊天的对话历史
 *   /session            → 查看当前聊天保留的轮数
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
import { dshRun } from "./dsh-cli.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../");
const STATE_FILE = resolve(__dirname, "../.state/transcripts.json");

// ── 会话中继能力（与角色相同的调用契约: {user_input,...} → {response}）──

export const dshRelayRef: CapabilityRef = {
  id: "@infrastructure/dsh-session-relay",
  versionRange: "^1.0.0",
};

export const dshRelayService: ServiceDefinition<{ user_input: string; user_id?: string }, { response: string }> = {
  id: "@infrastructure/dsh-session-relay",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "企微消息 → 官方 dsh headless agent 会话中继（滚动上下文多轮）",
};

/** 企微 Markdown 长度上限（保守截断，保留尾部结论） */
const MAX_REPLY = 3500;

/** 滚动上下文上限：最多保留的对话轮数 / 总字符数（超出丢最旧） */
const MAX_TURNS = 12;
const MAX_CONTEXT_CHARS = 6000;

/**
 * 按 chatId 滚动对话历史（JSON 持久化，重启不丢）。
 * headless runner 无 --resume，多轮记忆靠把此历史拼进下一条任务文本。
 */
class TranscriptStore {
  private map = new Map<string, Array<{ role: "user" | "assistant"; text: string }>>();
  constructor(private readonly filePath: string) {
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, Array<{ role: "user" | "assistant"; text: string }>>;
        for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) this.map.set(k, v);
      }
    } catch (e) {
      console.warn("[transcript] 读取失败, 从空历史开始:", e);
    }
  }
  get(chatId: string): Array<{ role: "user" | "assistant"; text: string }> {
    return this.map.get(chatId) ?? [];
  }
  push(chatId: string, role: "user" | "assistant", text: string): void {
    const turns = this.get(chatId);
    turns.push({ role, text });
    while (turns.length > MAX_TURNS || turns.reduce((n, t) => n + t.text.length, 0) > MAX_CONTEXT_CHARS) {
      if (turns.length <= 1) break;
      turns.shift();
    }
    this.map.set(chatId, turns);
    this.flush();
  }
  clear(chatId: string): void {
    this.map.delete(chatId);
    this.flush();
  }
  private flush(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8");
  }
}

function createRelayProvider(): Provider<{ user_input: string; user_id?: string }, { response: string }> {
  const dshBinJs = process.env["DSH_BIN"] ?? "";
  const dshHome = process.env["DSH_HOME"] ?? "";
  const cwd = process.env["DSH_CWD"] ?? REPO_ROOT;
  const transcript = new TranscriptStore(STATE_FILE);

  const extraEnv: Record<string, string> = {};
  for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DSH_PERMISSION_MODE"]) {
    const v = process.env[key];
    if (v) extraEnv[key] = v;
  }

  const run = (task: string) => dshRun({ dshBinJs, dshHome, cwd, task, extraEnv });

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
        transcript.clear(chatId);
        return ok({ response: "✅ 已清空当前聊天的对话历史，下条消息从零开始。" });
      }
      if (text === "/session") {
        const turns = transcript.get(chatId).length;
        return ok({ response: turns > 0 ? `当前保留 ${turns} 轮对话上下文。` : "尚无对话历史。" });
      }

      // 组装任务文本: 滚动历史 + 本次消息（headless 无 --resume, 多轮靠上下文注入）
      const history = transcript.get(chatId);
      const contextBlock = history.length
        ? history.map((t) => `${t.role === "user" ? "用户" : "助手"}: ${t.text}`).join("\n") + "\n\n"
        : "";
      console.log(`[relay] chat=${chatId} history=${history.length}轮 task=${text.slice(0, 60)}…`);
      const result = await run(contextBlock ? `以下是此前的对话记录（供参考上下文）:\n${contextBlock}请回答本次消息: ${text}` : text);

      if (!result.ok) {
        return ok({ response: `⚠️ agent 执行失败 (${(result.durationMs / 1000).toFixed(0)}s):\n${result.error ?? "未知错误"}` });
      }

      transcript.push(chatId, "user", text);

      let response = result.output || "(agent 无文本输出)";
      transcript.push(chatId, "assistant", response);
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

  loadEnv(resolve(__dirname, "../.env"));
  const botId = process.env["WECOM_DSH_BOT_ID"] ?? "";
  const secret = process.env["WECOM_DSH_BOT_SECRET"] ?? "";
  if (!botId || !secret) {
    console.error("缺少凭证: 请在 .env 设置 WECOM_DSH_BOT_ID / WECOM_DSH_BOT_SECRET");
    process.exit(1);
  }
  if (!process.env["DSH_BIN"] || !process.env["DSH_HOME"]) {
    console.error(
      "缺少配置: 请在 examples/wecom-dsh/.env 设置 DSH_BIN（官方 dsh 的 lib/bin.js 绝对路径）与 DSH_HOME\n" +
        "模板见 examples/wecom-dsh/.env.example",
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
