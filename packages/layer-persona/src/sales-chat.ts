/**
 * L3 感知交互层: 平台客服角色形象 (sales-chat)
 *
 * L3 的职责: 构建主体形象，接收信号，委托 L4 编排，由同一角色反馈。
 * 不关心调什么工具、走什么流程——那是 L4 的事。
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
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

// ── 服务定义 ─────────────────────────────────────────────────────

export interface SalesChatRequest {
  /** 用户输入 */
  user_input: string;
  /** 商户 ID */
  merchant_id?: string;
  /** 客户 ID */
  customer_id?: string;
  /** 用户标识 (大厅登录邮箱; 用于 TiMEM 记忆按用户隔离) */
  user_key?: string;
  /** 会话 ID (可选) */
  session_id?: string;
  /** 会话历史 (前端维护, 透传给编排层做上下文) */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 动态上下文: hall 注入的当前注册角色清单 (客服据此回答"有哪些角色", 不靠手写清单) */
  hall_roles?: Array<{ id: string; name: string; emoji: string }>;
}

export interface SalesChatResponse {
  /** 回复内容 */
  response: string;
  /** 角色身份 */
  agent_name: string;
  /** 会话 ID */
  session_id: string;
  /** 追踪 ID */
  trace_id: string;
  /** true = LLM 不可用, 本次回复来自降级 stub */
  degraded?: boolean;
}

export const salesChatService: ServiceDefinition<SalesChatRequest, SalesChatResponse> = {
  id: "@persona/sales-chat",
  version: "1.0.0",
  layer: LayerId.Persona,
  description: "平台客服角色形象：解答系统使用问题 → 委托 L4 → 回文字",
};

// ── Provider 实现 ────────────────────────────────────────────────

// ── Provider 实现 ────────────────────────────────────────────────

/** AppBase 系统知识 (客服的产品手册, 随提问注入 LLM) */
const APPBASE_SUPPORT_PROMPT = [
  '你是「平台客服」, 专门解答用户关于 AppBase 系统的任何问题。请用简体中文回答。',
  '',
  '【AppBase 是什么】一个 AI 应用工厂: 大厅里可以打开 AI 生成的网页应用、与对话角色聊天、在编码工作台让 AI 修改应用代码。',
  '',
  '【核心功能】',
  '1. 应用大厅 (/hall): 卡片墙展示所有应用。每个应用可打开、设置(可登录账号 / LLM 配置 / .env 配置)。',
  '2. 对话角色: 网页应用开发员(动手生成/修改 HTML 应用)、编码教练(分步引导设计, 只讲不动手)、应用报修客服(聊天收集问题 → 汇总成工单草稿 → 确认建单)、平台客服(本角色)。当前实际可用的角色清单见下方【动态角色清单】, 以它为准。',
  '3. 编码工作台 (/hall/workbench): 选角色 + 目标应用 + 编码工具(自动检测本机可用性), AI 直接修改应用代码; 改动前自动快照备份; 聊天记录按 角色+应用+工具 自动保存, 且云端持久化(退出登录/换浏览器不丢)。',
  '4. 管理中心 (/admin): 管理员专用, 四个标签 —— 账号与用户(注册账号管理/审计日志)、LLM 配置(多平台 Key, 保存并启用即热生效, 可测试连接/拉取模型列表)、DSH 插件(注册/配置/加载)、框架层插件(只读查看)。大厅右上角「⚙ 管理」进入。',
  '5. LLM 配置: 全局多平台配置(管理中心, 热生效) + 每个应用可单独覆盖(URL / API Key / 模型), Key 保存在服务端, 应用前端不接触; AI 调用走服务端代理。',
  '6. .env 配置: 每个应用可有额外 KEY=VALUE 配置, 应用运行时通过 window.APP_ENV 读取; 数据转发目标(RELAY_名字=地址)也在这里配。',
  '7. 班主任小本本 (teacher-notebook): 内置演示应用 —— 班级管理: 名册(批量导入)、考勤(出勤/迟到/请假/缺勤)、记忆本(AI 结构化记录学生行为/纪律/成绩/交际)、学生画像(四维聚合+时间线+AI提示词导出)、随机点名、积分(积分必须经由记忆本记录产生)。',
  '',
  '【常见问题】',
  '- 打开应用提示 401/未授权: 需要登录该应用的账号; 账号由管理员在管理中心添加。',
  '- AI 功能报错: 检查管理中心 LLM 配置(全局或该应用), 或上游平台余额/Key 失效。',
  '- 数据在哪: 聊天历史与应用数据云端持久化(PostgreSQL), 换设备登录同一账号即可恢复。',
  '- 新建应用打不开: 应用文件需在大厅根目录; 开发员生成的应用会自动移入, 稍等刷新即可。',
  '',
  '【职责边界与转介】',
  '- 平台客服只答 AppBase 产品的使用问题。',
  '- 遇到五域架构/Seam 契约/插件开发/py-bridge 等框架机制问题: 不要尝试解释, 明确回复「这是框架内部实现话题, 我专门负责产品使用问题; 机制细节请查阅仓库 README 与 docs/ 目录」, 然后把话题引回产品使用。',
  '- 报修请找应用报修客服; 学做应用找编码教练; 改代码找网页应用开发员。',
  '',
  '回答原则: 结论先行、具体可操作; 不知道的功能如实说, 不编造。',
].join("\n");

const salesChatProvider: Provider<SalesChatRequest, SalesChatResponse> = {
  service: salesChatService,
  name: "persona-sales-chat-text",
  state: PluginState.Active,
  async execute(
    request: SalesChatRequest,
    ctx: SeamContext,
  ): Promise<Result<SalesChatResponse>> {
    // 1. 角色形象: "我是平台客服"
    const agentName = "平台客服";
    const memUserId = request.user_key ?? request.customer_id ?? "anonymous";

    // 2. 动态角色清单 (hall 注入): 手册里的角色描述是稳定的, 清单以实际注册为准
    let dynamicBlock = "";
    if (request.hall_roles?.length) {
      dynamicBlock += "\n\n【动态角色清单】(当前大厅实际注册的角色, 回答「有哪些角色/找谁」时以此为准):\n"
        + request.hall_roles.map((r) => `${r.emoji} ${r.name} (${r.id})`).join("\n");
    }

    // 3. TiMEM 记忆召回 (尽力而为): agent_id 按角色隔离, 只召回平台客服域的记忆
    try {
      const mem = await ctx.call(
        { id: "@cognitive/timem-memory", versionRange: "^1.0.0" },
        { query: request.user_input.slice(0, 200), user_id: memUserId, agent_id: "sales-chat", limit: 3 },
      );
      const value = (mem as { value?: { ok?: boolean; results?: Array<{ content: string }>; error?: string } }).value;
      const items = value?.ok ? (value.results ?? []).map((r) => r.content).filter(Boolean) : [];
      if (items.length > 0) {
        dynamicBlock += `\n\n【该用户在本客服的历史相关记忆】(相关时提及, 不确定时询问)\n${items.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
      }
      console.log(`[sales-mem] recalled ${items.length} memories for ${memUserId}${value?.ok ? "" : ` (timem: ${value?.error ?? "unavailable"})`}`);
    } catch (e) {
      console.log(`[sales-mem] recall skipped: ${String((e as Error)?.message ?? e)}`);
    }

    // 4. 构建 ChatRequest (带角色身份 + 动态上下文 + 会话记忆透传)
    const chatRequest = {
      user_input: request.user_input,
      merchant_id: request.merchant_id ?? "default",
      customer_id: memUserId,
      session_id: request.session_id ?? ctx.sessionId,
      agent_name: agentName,
      system_prompt: APPBASE_SUPPORT_PROMPT + dynamicBlock,
      ...(request.history?.length ? { history: request.history } : {}),
    };

    // 3. 委托 L4 编排 (L4 决定调什么工具、走什么流程)
    const result = await ctx.call(
      { id: "@orchestration/workflow-engine", versionRange: "^1.0.0" },
      chatRequest,
    );

    // 4. 由同一个角色形象反馈
    const wfValue = (result as { ok: boolean; value?: { result?: string; response?: string; degraded?: boolean } })
      .value;
    const response = (result as { ok: boolean }).ok
      ? (wfValue?.result ?? wfValue?.response ?? "抱歉，我没有理解您的意思。")
      : "抱歉，智能助理暂时无法响应，请稍后重试。";

    // 记忆沉淀 (尽力而为): 降级占位回复不写入, 避免污染长期记忆; agent_id 按角色隔离
    if ((result as { ok: boolean }).ok && !wfValue?.degraded) {
      try {
        const w = await ctx.call(
          { id: "@cognitive/timem-memory-write", versionRange: "^1.0.0" },
          {
            content: `平台客服对话 (${new Date().toISOString().slice(0, 10)}): 用户问「${request.user_input.slice(0, 150)}」; 答复要点: ${response.slice(0, 200)}`,
            user_id: memUserId,
            agent_id: "sales-chat",
          },
        );
        const wv = (w as { value?: { ok?: boolean; error?: string } }).value;
        if (wv?.ok) console.log(`[sales-mem] saved exchange for ${memUserId}`);
        else console.log(`[sales-mem] save failed: ${wv?.error ?? "unknown"}`);
      } catch (e) {
        console.log(`[sales-mem] save skipped: ${String((e as Error)?.message ?? e)}`);
      }
    }

    return ok({
      response,
      agent_name: agentName,
      session_id: ctx.sessionId,
      trace_id: ctx.traceId,
      ...(wfValue?.degraded ? { degraded: true } : {}),
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "sales-chat ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

export { salesChatProvider };

// ── 插件 Manifest 与 LayerPlugin ─────────────────────────────────

export const manifest: PluginManifest = {
  name: "@persona/sales-chat",
  layer: LayerId.Persona,
  description: "感知层：文字对话方角色形象",
  version: "0.1.0",
  provides: [salesChatService],
  consumes: [{ id: "@orchestration/workflow-engine", versionRange: "^1.0.0" }],
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
    return [salesChatProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
