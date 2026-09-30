/**
 * 通道聚合器 —— 角色声明 → 通道装配计划（角色通道声明模型设计 §三）
 *
 * 读全部角色 manifest，按 app 分组生成 feishu-ingress 装配计划：
 * 同一角色挂多平台/多 app（基线 4）→ 多条 app 连接，但 agentRoutes 全部指向
 * 同一 persona、记忆域同一 memory.agent_id（跨平台同一人, 基线 3/4）。
 *
 * M1 边界：只生成装配计划（dry-run，纯函数可单测）+ 单 app 真连装配函数；
 * 不在平台启动时自动接管现有通道（避免与运行中的独立进程抢事件）——
 * 真连切换由 env CHANNEL_AGGREGATOR_ENABLED=1 显式开启（M2 逐角色迁移）。
 */
import { canonicalTimemUserId, findMemberByAxis } from "@aigility-harness/layer-orchestration";
import type { IdentityRegistryFile } from "@aigility-harness/layer-orchestration";
import type { FeishuIngressRequest } from "@aigility-harness/layer-infrastructure";
import { loadRoleManifestFile, validateManifest, type RoleManifestV2 } from "./role-manifest.js";

export interface AppPlan {
  platform: "feishu" | "wecom";
  appId: string;
  /** 经此 app 的路由：会话/命中键 → persona */
  agentRoutes: Record<string, string>;
  /** 兜底 persona（该 app 上声明角色的第一个） */
  perceptionId: string;
  /** 声明此 app 的角色（一个 app 面貌上属一个角色, 基线 2） */
  roleIds: string[];
  /** 该 app 上活跃角色共享的记忆域（应全部相同——否则跨平台归一被破坏） */
  memoryAgentIds: string[];
}

export interface AggregatorPlan {
  apps: AppPlan[];
  /** 校验/一致性问题（声明错误、面貌不一致、同 app 多角色冲突） */
  issues: string[];
  /** 未绑定任何通道的纯网页角色（基线 1） */
  webOnlyRoleIds: string[];
}

/** 生成装配计划（dry-run 纯函数） */
export function buildAggregatorPlan(manifests: RoleManifestV2[]): AggregatorPlan {
  const issues: string[] = [];
  const byApp = new Map<string, AppPlan>();
  const webOnly: string[] = [];

  for (const m of manifests) {
    const vIssues = validateManifest(m);
    if (vIssues.length) {
      issues.push(`角色 ${m.role_id || "(未命名)"}: ${vIssues.join("; ")}`);
      continue;
    }
    const personaId = `@persona/${m.identity.capability_ref ?? m.role_id}`;
    const channels = m.sources.channels ?? [];
    if (!channels.length) {
      webOnly.push(m.role_id);
      continue;
    }
    for (const c of channels) {
      for (const a of c.apps) {
        let plan = byApp.get(a.app);
        if (!plan) {
          plan = { platform: c.platform, appId: a.app, agentRoutes: {}, perceptionId: personaId, roleIds: [], memoryAgentIds: [] };
          byApp.set(a.app, plan);
        }
        if (plan.platform !== c.platform) issues.push(`app ${a.app} 被声明为多平台（${plan.platform} 与 ${c.platform}）——app 只属一个平台`);
        // 面貌=本体（基线 2）：一个 app 只能承载一个角色本体
        if (plan.roleIds.length && !plan.roleIds.includes(m.role_id)) {
          issues.push(`app ${a.app} 已绑定角色 ${plan.roleIds.join("/")}，又声明角色 ${m.role_id}——面貌一致性冲突（基线 2）`);
        } else if (!plan.roleIds.includes(m.role_id)) {
          plan.roleIds.push(m.role_id);
        }
        if (!plan.memoryAgentIds.includes(m.memory.agent_id)) plan.memoryAgentIds.push(m.memory.agent_id);
        // 路由：声明的会话逐条映射；无 chats 则记 default 路由（mention_only 语义由 ingress 执行）
        if (a.chats?.length) {
          for (const chat of a.chats) plan.agentRoutes[chat] = personaId;
        } else {
          plan.agentRoutes["*"] = personaId;
        }
      }
    }
  }
  for (const [appId, plan] of byApp) {
    if (plan.memoryAgentIds.length > 1) {
      issues.push(`app ${appId} 上多角色记忆域不一致 (${plan.memoryAgentIds.join(", ")})——跨平台归一被破坏（基线 3/4）`);
    }
  }
  return { apps: [...byApp.values()], issues, webOnlyRoleIds: webOnly };
}

/** 便捷读取：仓库 config/role-manifests.json → 计划 */
export function buildAggregatorPlanFromConfig(): AggregatorPlan {
  return buildAggregatorPlan(loadRoleManifestFile().roles);
}

/** 把计划中的 feishu app 转成 feishu-ingress 装配请求（真连装配用；M2 起 enableChannelAggregator 调用） */
export function toFeishuIngressRequest(plan: AppPlan): FeishuIngressRequest {
  if (plan.platform !== "feishu") throw new Error(`app ${plan.appId} 不是 feishu 平台`);
  return {
    appId: plan.appId,
    agentRoutes: plan.agentRoutes,
    perceptionId: plan.perceptionId,
  };
}

/**
 * 通道事件 → 规范 user_id（两维纪律的 user 维执行点）：
 * 命中登记表 → canonicalTimemUserId（真身太忆云账号）；未命中 → 来源键
 * （`feishu:<open_id>` / `wecom:<userid>` / `web:<email>`，绝不裸 anonymous）。
 * 聚合器与各通道消费者共用；绑定后同键自然归并（identity-registry 热重载）。
 */
export function resolveChannelUserId(
  registry: IdentityRegistryFile,
  platform: "feishu" | "wecom" | "web",
  platformUid: string,
): string {
  const member =
    platform === "feishu"
      ? findMemberByAxis(registry, "feishu", platformUid)
      : platform === "wecom"
        ? findMemberByAxis(registry, "wecom", platformUid)
        : findMemberByAxis(registry, "web", platformUid);
  if (!member) return `${platform}:${platformUid}`;
  return canonicalTimemUserId(member);
}
