/**
 * 人员对齐登记表 (identity registry) — 飞书 / 企微 / Gitea / 网页 / 太忆云 五轴身份解析
 *
 * 数据源: config/timem-team-registry.json（$schema 见同目录 .schema.md）
 * 设计约定（2026-09-30 与用户对齐）：
 *   - agent 维度用 agent_id 区分（项目小助理 = feishu-task-assistant），
 *     user 维度用 user_id 标识「人」——同一个自然人跨来源必须是同一个 user_id。
 *   - timem 写入/召回的规范 user_id = timem_user_ids[0]（真身太忆云账号，
 *     将来可在太忆空间里看到自己的记忆），缺失时回退 member_id。
 *   - feishu/gitea 轴的绑定带来源标记（manual=人工确认 / auto=自动匹配），
 *     自动匹配永不覆盖 manual。
 *
 * 纯逻辑 + 文件 IO，不发网络请求；候选拉取与自动匹配打分见平台 identity-manager。
 * mtime 缓存：平台页保存后，运行中的项目小助理下一次调用即读到新配置。
 */

import { renameSync, writeFileSync } from "node:fs";
import { createRegistryReader, findRepoConfigFile } from "./registry-util.js";

// ── 类型 ─────────────────────────────────────────────────────────

export type IdentityAxis = "feishu" | "wecom" | "gitea" | "web" | "timem";
export type MatchSource = "manual" | "auto";

export interface IdentityMember {
  member_id: string;
  name: string;
  aliases: string[];
  timem_user_ids: string[];
  feishu_open_ids: string[];
  gitea_usernames: string[];
  /** 企微 userid（通道收口后启用；M1 起登记表支持） */
  wecom_user_ids: string[];
  /** 网页登录邮箱（AppBase users.email, 小写归一）——网页内勤对话的解析锚点 */
  web_emails: string[];
  /** 各身份轴的绑定来源；缺省视为 manual（老数据兼容） */
  match_source?: Partial<Record<IdentityAxis, MatchSource>>;
  role?: string;
  team?: string;
  email?: string;
  notes?: string;
}

export interface IdentityRegistryFile {
  version: number;
  updated_at: string;
  notes?: string[];
  members: IdentityMember[];
}

// ── 归一化（老版本文件缺新字段时补默认值） ──────────────────────

export function normalizeMember(raw: Partial<IdentityMember>): IdentityMember {
  return {
    member_id: String(raw.member_id ?? ""),
    name: String(raw.name ?? ""),
    aliases: (raw.aliases ?? []).map(String),
    timem_user_ids: (raw.timem_user_ids ?? []).map(String),
    feishu_open_ids: (raw.feishu_open_ids ?? []).map(String),
    gitea_usernames: (raw.gitea_usernames ?? []).map((s) => String(s).toLowerCase()),
    wecom_user_ids: (raw.wecom_user_ids ?? []).map(String),
    web_emails: (raw.web_emails ?? []).map((s) => String(s).toLowerCase()),
    match_source: raw.match_source ?? {},
    role: raw.role,
    team: raw.team,
    email: raw.email,
    notes: raw.notes,
  };
}

function emptyRegistry(): IdentityRegistryFile {
  return { version: 2, updated_at: new Date().toISOString(), members: [] };
}

const readRegistry = createRegistryReader<IdentityRegistryFile>("timem-team-registry.json", emptyRegistry);

/** 读登记表（env TEAM_IDENTITY_REGISTRY 可覆盖路径；平台改文件后自动生效） */
export function getIdentityRegistry(pathOverride?: string): IdentityRegistryFile {
  const file = readRegistry(pathOverride ?? identityRegistryPath());
  if (!Array.isArray(file.members)) file.members = [];
  return file;
}

/** 规范 member 列表（解析调用方用；直接读原始 file 时字段可能缺省） */
export function identityMembers(file: IdentityRegistryFile): IdentityMember[] {
  return file.members.map(normalizeMember);
}

/** 原子写回（tmp + rename），刷新 updated_at；平台审查页与自动匹配共用 */
export function persistIdentityRegistry(path: string, file: IdentityRegistryFile): void {
  file.updated_at = new Date().toISOString();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

// ── 路径 ─────────────────────────────────────────────────────────

export function identityRegistryPath(): string | undefined {
  return process.env.TEAM_IDENTITY_REGISTRY || findRepoConfigFile("timem-team-registry.json");
}

// ── 解析 ─────────────────────────────────────────────────────────

function eq(s: string, t: string): boolean {
  return s.trim().toLowerCase() === t.trim().toLowerCase();
}

function nameSet(m: IdentityMember): string[] {
  return [m.name, ...m.aliases].filter(Boolean);
}

/** 飞书 open_id → 成员 */
export function findMemberByFeishuOpenId(file: IdentityRegistryFile, openId: string): IdentityMember | undefined {
  if (!openId) return undefined;
  return identityMembers(file).find((m) => m.feishu_open_ids.some((x) => eq(x, openId)));
}

/** 企微 userid → 成员（大小写不敏感，登记时归一小写） */
export function findMemberByWecomUserId(file: IdentityRegistryFile, userId: string): IdentityMember | undefined {
  if (!userId) return undefined;
  const u = userId.trim().toLowerCase();
  return identityMembers(file).find((m) => m.wecom_user_ids.includes(u));
}

/** 网页登录邮箱 → 成员（大小写不敏感） */
export function findMemberByWebEmail(file: IdentityRegistryFile, email: string): IdentityMember | undefined {
  if (!email) return undefined;
  const e = email.trim().toLowerCase();
  return identityMembers(file).find((m) => m.web_emails.includes(e));
}

/** Gitea 用户名 → 成员（大小写不敏感） */
export function findMemberByGiteaUsername(file: IdentityRegistryFile, username: string): IdentityMember | undefined {
  if (!username) return undefined;
  const u = username.trim().toLowerCase();
  return identityMembers(file).find((m) => m.gitea_usernames.includes(u));
}

/** 太忆云 user_id → 成员 */
export function findMemberByTimemUserId(file: IdentityRegistryFile, userId: string): IdentityMember | undefined {
  if (!userId) return undefined;  return identityMembers(file).find((m) => m.timem_user_ids.some((x) => eq(x, userId)));
}

/**
 * 姓名/别名 → 成员（先精确后包含式模糊；歧义返回候选列表）。
 * 与 team-memory-console TeamRegistry.resolve 同语义。
 */
export function resolveMemberByName(
  file: IdentityRegistryFile,
  rawName: string,
): { kind: "exact"; member: IdentityMember } | { kind: "ambiguous"; candidates: IdentityMember[] } | { kind: "none" } {
  const q = rawName.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return { kind: "none" };
  const members = identityMembers(file);
  for (const m of members) {
    if (m.member_id === rawName) return { kind: "exact", member: m };
    if (nameSet(m).some((n) => n.trim().toLowerCase().replace(/\s+/g, "") === q)) return { kind: "exact", member: m };
  }
  const hit = members.filter((m) =>
    nameSet(m).some((n) => n.trim().toLowerCase().replace(/\s+/g, "").includes(q)),
  );
  if (hit.length === 1) return { kind: "exact", member: hit[0] };
  if (hit.length > 1) return { kind: "ambiguous", candidates: hit };
  return { kind: "none" };
}

/**
 * 成员的规范 timem user_id（个人记忆的写入/召回键）：
 * timem_user_ids[0] 优先（真身太忆云账号），缺失回退 member_id。
 */
export function canonicalTimemUserId(m: IdentityMember): string {
  return m.timem_user_ids[0] ?? m.member_id;
}

// ── 绑定管理（纯函数，配合 persistIdentityRegistry 使用） ────────

/** 轴 → 该成员的 id 列表字段 */
export function axisIds(m: IdentityMember, axis: IdentityAxis): string[] {
  return axis === "feishu"
    ? m.feishu_open_ids
    : axis === "wecom"
      ? m.wecom_user_ids
      : axis === "gitea"
        ? m.gitea_usernames
        : axis === "web"
          ? m.web_emails
          : m.timem_user_ids;
}

/**
 * 给成员绑定一条身份（幂等）。同轴同 id 已绑定他人时抛错（防串号）；
 * source=manual 会覆盖 auto 标记，auto 不覆盖 manual。
 */
export function bindIdentityAxis(
  file: IdentityRegistryFile,
  memberId: string,
  axis: IdentityAxis,
  id: string,
  source: MatchSource,
): void {
  const value = (axis === "gitea" || axis === "wecom" || axis === "web" ? id.trim().toLowerCase() : id.trim());
  if (!value) throw new Error("绑定值不能为空");
  const member = file.members.find((m) => m.member_id === memberId);
  if (!member) throw new Error(`未找到成员: ${memberId}`);
  const owner = findMemberByAxis(file, axis, value);
  if (owner && owner.member_id !== memberId) {
    throw new Error(`${axis} 身份 ${value} 已绑定给 ${owner.name} (${owner.member_id})，先解绑再改绑`);
  }
  const ids = axisIds(member, axis);
  if (!ids.some((x) => eq(x, value))) ids.push(value);
  const prev = member.match_source?.[axis];
  if (prev !== "manual" || source === "manual") {
    member.match_source = { ...(member.match_source ?? {}), [axis]: source };
  }
}

/** 同轴查占用（gitea 轴大小写不敏感） */
export function findMemberByAxis(file: IdentityRegistryFile, axis: IdentityAxis, id: string): IdentityMember | undefined {
  return axis === "feishu"
    ? findMemberByFeishuOpenId(file, id)
    : axis === "wecom"
      ? findMemberByWecomUserId(file, id)
      : axis === "gitea"
        ? findMemberByGiteaUsername(file, id)
        : axis === "web"
          ? findMemberByWebEmail(file, id)
          : findMemberByTimemUserId(file, id);
}

/** 解绑一条身份（幂等；来源标记同步清除） */
export function unbindIdentityAxis(file: IdentityRegistryFile, memberId: string, axis: IdentityAxis, id: string): void {
  const member = file.members.find((m) => m.member_id === memberId);
  if (!member) throw new Error(`未找到成员: ${memberId}`);
  const value = (axis === "gitea" ? id.trim().toLowerCase() : id.trim());
  if (axis === "feishu") member.feishu_open_ids = member.feishu_open_ids.filter((x) => !eq(x, value));
  else if (axis === "wecom") member.wecom_user_ids = member.wecom_user_ids.filter((x) => !eq(x, value));
  else if (axis === "gitea") member.gitea_usernames = member.gitea_usernames.filter((x) => !eq(x, value));
  else if (axis === "web") member.web_emails = member.web_emails.filter((x) => !eq(x, value));
  else member.timem_user_ids = member.timem_user_ids.filter((x) => !eq(x, value));
  if (axisIds(member, axis).length === 0) {
    const src = { ...(member.match_source ?? {}) };
    delete src[axis];
    member.match_source = src;
  }
}

// ── 自动匹配打分（纯函数；候选拉取在平台侧） ────────────────────

export interface IdentityCandidate {
  /** 候选 id（gitea login / 飞书 open_id） */
  id: string;
  /** 候选显示名（gitea full_name / 飞书姓名） */
  name?: string;
}

export interface ScoredCandidate {
  candidate: IdentityCandidate;
  score: number;
  reason: string;
}

function squash(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 成员 × 候选打分（0-100）：
 *   100 = 候选 id/显示名与姓名或别名完全一致
 *    70 = 互相包含（长度 ≥3，防止单字母误配）
 *    50 = 前缀命中（≥3 字符）
 * 打分只做推荐，落库一律走人工确认（manual）或标记 auto 待确认。
 */
export function scoreIdentityCandidates(m: IdentityMember, candidates: IdentityCandidate[]): ScoredCandidate[] {
  const names = nameSet(m).map(squash).filter(Boolean);
  const out: ScoredCandidate[] = [];
  for (const c of candidates) {
    const ids = squash(c.id);
    const disp = squash(c.name ?? "");
    let score = 0;
    let reason = "";
    for (const n of names) {
      if ((ids && ids === n) || (disp && disp === n)) {
        score = Math.max(score, 100);
        reason = `名称完全匹配「${c.name ?? c.id}」`;
        break;
      }
      if (n.length >= 3 && ((ids && ids.includes(n)) || (disp && disp.includes(n)))) {
        score = Math.max(score, 70);
        reason = reason || `显示名包含「${n}」`;
      } else if (n.length >= 3 && n.includes(disp) && disp.length >= 3) {
        score = Math.max(score, 70);
        reason = reason || `别名包含显示名「${c.name ?? c.id}」`;
      } else if (n.length >= 3 && ((ids && ids.startsWith(n)) || (disp && disp.startsWith(n)))) {
        score = Math.max(score, 50);
        reason = reason || `前缀命中「${n}」`;
      }
    }
    if (score > 0) out.push({ candidate: c, score, reason });
  }
  return out.sort((a, b) => b.score - a.score);
}
