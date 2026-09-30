/**
 * 角色 manifest v2 —— 五要素声明层（角色通道声明模型设计 §二, docs/角色通道声明模型设计.md）
 *
 * 与 roles.json 的关系：roles.json 继续管能力面（skills/mcpServers/routes, feishu-dsh
 * 会话中继热读取零改动）；本文件（config/role-manifests.json）只声明五要素的通道与
 * 记忆归集事实，按 role id 与 roles.json 的角色关联。声明与能力分离——改通道不动能力。
 *
 * 四条基线（用户拍板）：
 *   - channels 可选（基线 1：纯网页/后台角色无此段）；
 *   - 面貌=本体（基线 2：app 注册信息按角色设定，checkFaceConsistency 静态核对）；
 *   - 跨位置同一角色（基线 3：memory.agent_id=role.id，网页与 IM 同一记忆域）；
 *   - 跨平台同一人（基线 4：同一角色 channels 数组挂多平台 app）。
 * 记忆纪律对齐两维模型（项目小助理-数据对齐与记忆设计 §一）：
 *   agent 维 = memory.agent_id（恒为 role.id）；user 维由 identity-registry 归集（人）。
 */
import { existsSync, readFileSync } from "node:fs";
import { findRepoConfigFile } from "@aigility-harness/layer-orchestration";

// ── 类型 ─────────────────────────────────────────────────────────

export type ChannelPlatform = "feishu" | "wecom";

export interface ChannelAppBinding {
  /** 平台 app 标识（appId；凭证存平台侧，声明不含明文密钥） */
  app: string;
  /** 监听的会话（群 chat_id / 私聊 p2p）；缺省 = 全部（mention_only 下仅被 @ 的会话） */
  chats?: string[];
  /** 仅被 @ 时响应（群聊）；缺省 false */
  mention_only?: boolean;
}

export interface ChannelBinding {
  platform: ChannelPlatform;
  /** 同一角色在该平台可绑定多个 app（跨平台=同一个人的多个账号, 基线 4） */
  apps: ChannelAppBinding[];
}

export interface RoleManifestV2 {
  /** 角色唯一 id = persona key（roles.json 的角色 id / persona id 去掉 @persona/ 前缀） */
  role_id: string;
  identity: {
    name: string;
    /** 展示签名（网页面貌用；IM 面貌=app 本体, 基线 2） */
    signature?: string;
    /** 能力面指针：roles.json 的角色 id（缺省 = role_id） */
    capability_ref?: string;
  };
  sources: {
    /** 通道订阅（可选：纯网页/后台角色省略, 基线 1） */
    channels?: ChannelBinding[];
    /** 数据资产绑定（数据面引用，如 alarm_log / neo4j:<name> / 知识库名） */
    data?: string[];
  };
  actions: {
    /** 工具委托（MCP 工具名 / skill 引用）；能力面细节仍归 roles.json */
    tools?: string[];
    /** 编排委托（工作流名，如 executor-dispatch） */
    workflows?: string[];
    /** 特例引擎委托（如 dsh-headless 会话桥, M3 收编项） */
    engine?: string;
  };
  outbound: {
    reply?: "same-channel";
    /** 主动播报目的地（如 feishu:oc_xxx）；task-loop 播报能力即此类（M2 接线） */
    push?: string[];
  };
  memory: {
    /** 跨位置/跨平台记忆域 = role.id（两维模型的 agent 维；user 维由 identity-registry 归集） */
    agent_id: string;
  };
}

export interface RoleManifestFile {
  version: number;
  updated_at: string;
  /** 文件首部 $schema 说明键（jsonschema 风格的文档注释, 原样保留回写） */
  doc_note?: string;
  notes?: string[];
  roles: RoleManifestV2[];
}

// ── 加载与校验 ───────────────────────────────────────────────────

export function roleManifestPath(): string | undefined {
  return process.env.ROLE_MANIFEST_PATH || findRepoConfigFile("role-manifests.json");
}

export function loadRoleManifestFile(pathOverride?: string): RoleManifestFile {
  const path = pathOverride ?? roleManifestPath();
  if (!path || !existsSync(path)) {
    return { version: 2, updated_at: new Date().toISOString(), roles: [] };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RoleManifestFile> & { $schema?: string };
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  return {
    version: 2,
    updated_at: String(raw.updated_at ?? ""),
    doc_note: raw.$schema,
    notes: raw.notes,
    roles: roles.map(normalizeManifest),
  };
}

function normalizeManifest(m: Partial<RoleManifestV2>): RoleManifestV2 {
  return {
    role_id: String(m.role_id ?? ""),
    identity: {
      name: String(m.identity?.name ?? ""),
      signature: m.identity?.signature,
      capability_ref: m.identity?.capability_ref,
    },
    sources: {
      channels: m.sources?.channels,
      data: m.sources?.data ?? [],
    },
    actions: {
      tools: m.actions?.tools ?? [],
      workflows: m.actions?.workflows ?? [],
      engine: m.actions?.engine,
    },
    outbound: {
      reply: m.outbound?.reply,
      push: m.outbound?.push ?? [],
    },
    memory: {
      agent_id: String(m.memory?.agent_id ?? m.role_id ?? ""),
    },
  };
}

/** 声明校验：返回问题列表（空 = 通过）。缺 role_id/identity.name/memory.agent_id 不合格 */
export function validateManifest(m: RoleManifestV2): string[] {
  const issues: string[] = [];
  if (!m.role_id) issues.push("缺 role_id");
  if (!m.identity.name) issues.push("缺 identity.name");
  if (!m.memory.agent_id) issues.push("缺 memory.agent_id（记忆域必须显式声明）");
  if (m.memory.agent_id && m.memory.agent_id !== m.role_id) {
    // 基线 3/4：记忆域随角色唯一——不一致视为声明错误（防分裂）
    issues.push(`memory.agent_id (${m.memory.agent_id}) 必须等于 role_id (${m.role_id})`);
  }
  for (const c of m.sources.channels ?? []) {
    if (!c.platform) issues.push("channel 缺 platform");
    if (!c.apps?.length) issues.push(`channel ${c.platform} 缺 apps`);
    for (const a of c.apps ?? []) {
      if (!a.app) issues.push(`channel ${c.platform} 有 app 绑定缺 app 标识`);
    }
  }
  return issues;
}

/**
 * 面貌一致性静态核对（基线 2）：app 注册名应与角色 identity.name 一致。
 * M1 只核对声明内自带的面貌快照（faceName，试点手工登记）；M2 可接平台侧 app 元数据表。
 */
export function checkFaceConsistency(
  m: RoleManifestV2,
  appFaceNames: Record<string, string> = {},
): Array<{ app: string; issue: string }> {
  const out: Array<{ app: string; issue: string }> = [];
  for (const c of m.sources.channels ?? []) {
    for (const a of c.apps ?? []) {
      const face = appFaceNames[a.app];
      if (face && face !== m.identity.name) {
        out.push({ app: a.app, issue: `app 面貌「${face}」与角色本体「${m.identity.name}」不一致（基线 2）` });
      }
    }
  }
  return out;
}
