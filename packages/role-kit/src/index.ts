/**
 * 角色包共享加载器（role-kit）—— harness 机制层
 *
 * 角色包 = 一个目录（SKILL.md 人设 + role.json 五要素声明），平台无关：
 *   - 公共角色：<repo>/roles/（harness 项目所有, git 版本化）；
 *   - 站点私有角色：各站自己的 roles 目录（同 id 站点优先——定制权在站点维护者）；
 * 解析顺序（先到先得）：站点目录列表（按优先级）→ 公共目录。
 *
 * 纯文件 IO，无运行时依赖（frontmatter 解析内置）；编辑器（智悦工厂等）与
 * 消费站点（feishu/wecom ingress、dsh headless）都走本加载器读角色。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── 类型 ─────────────────────────────────────────────────────────

export interface RoleManifest {
  role_id: string;
  identity: {
    name: string;
    signature?: string;
    /** 能力面指针（站点内 roles.json 角色 id / persona key） */
    capability_ref?: string;
  };
  sources: {
    /** 通道订阅（可选：纯网页/后台角色省略, 基线 1） */
    channels?: Array<{ platform: string; apps: Array<{ app: string; chats?: string[]; mention_only?: boolean }> }>;
    /** 数据资产绑定 */
    data?: string[];
  };
  actions: {
    tools?: string[];
    workflows?: string[];
    /** 确定性命令/意图表（pattern→编排动作；零 LLM 成本路径） */
    commands?: Array<{ pattern: string; action: string; summary?: string }>;
    /** 进程内调度器声明（interval/silence/daily/event；enabled=false 即旁路） */
    schedules?: Array<{ name: string; trigger: string; action: string; summary?: string; enabled?: boolean }>;
    /** 特例引擎委托（如 dsh-headless 会话桥） */
    engine?: string;
  };
  outbound: {
    reply?: "same-channel";
    push?: string[];
  };
  memory: {
    /** 记忆域恒 = role.id（基线 3/4：跨位置/跨平台同一份） */
    agent_id: string;
    /** 迁移前旧记忆域（如实登记，待迁移后删除） */
    legacy_agent_ids?: string[];
  };
}

export interface RolePackage {
  /** role.id（= 目录名 = persona key = 记忆域） */
  id: string;
  /** 包来源目录（公共 or 站点私有） */
  dir: string;
  /** 来源层 */
  layer: "public" | "site";
  /** SKILL.md frontmatter */
  name: string;
  description: string;
  /** 角色 Prompt（SKILL.md 正文） */
  prompt: string;
  /** 五要素声明 */
  manifest: RoleManifest;
}

export interface RoleKitOptions {
  /** 公共角色目录（缺省 <repo>/roles/, 由调用方传绝对路径） */
  publicDir: string;
  /** 站点私有角色目录（优先级高于公共；数组按优先级排列） */
  siteDirs?: string[];
}

// ── SKILL.md frontmatter 解析（内置, 无依赖）─────────────────────

function parseFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { body: md.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { ...meta, body: md.slice(m[0].length).trim() };
}

// ── 加载 ─────────────────────────────────────────────────────────

/** 单目录扫描：子目录含 SKILL.md + role.json 即一个角色包 */
function scanDir(dir: string, layer: "public" | "site"): RolePackage[] {
  if (!existsSync(dir)) return [];
  const out: RolePackage[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir_ = join(dir, entry.name);
    const skillMd = join(dir_, "SKILL.md");
    const roleJson = join(dir_, "role.json");
    if (!existsSync(skillMd) || !existsSync(roleJson)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillMd, "utf8"));
      const manifest = JSON.parse(readFileSync(roleJson, "utf8")) as RoleManifest;
      if (!manifest.role_id) continue;
      out.push({
        id: manifest.role_id,
        dir: dir_,
        layer,
        name: fm.name ?? manifest.identity.name ?? manifest.role_id,
        description: fm.description ?? manifest.identity.name ?? "",
        prompt: fm.body,
        manifest,
      });
    } catch {
      // 单包损坏不拖垮目录
    }
  }
  return out;
}

/**
 * 加载全部角色包：站点目录（按序）→ 公共目录；同 id 站点优先（定制权在站点）。
 */
export function loadRolePackages(opts: RoleKitOptions): RolePackage[] {
  const byId = new Map<string, RolePackage>();
  const siteDirs = opts.siteDirs ?? [];
  // 先公共后站点：站点后写入即覆盖（Map 语义）
  for (const pkg of scanDir(opts.publicDir, "public")) byId.set(pkg.id, pkg);
  for (const dir of [...siteDirs].reverse()) {
    for (const pkg of scanDir(dir, "site")) byId.set(pkg.id, pkg);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 按 role.id 取单个角色包（未命中返回 null） */
export function loadRolePackage(id: string, opts: RoleKitOptions): RolePackage | null {
  return loadRolePackages(opts).find((p) => p.id === id) ?? null;
}

/** manifest 校验：缺 role_id / memory.agent_id≠role_id 视为不合格 */
export function validateRoleManifest(m: RoleManifest): string[] {
  const issues: string[] = [];
  if (!m.role_id) issues.push("缺 role_id");
  if (!m.memory || m.memory.agent_id !== m.role_id) issues.push(`memory.agent_id 必须等于 role_id（基线 3/4：跨位置/跨平台同一记忆域）`);
  return issues;
}
