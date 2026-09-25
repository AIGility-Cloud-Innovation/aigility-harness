/**
 * 成员登记表 (Team Registry) — 团队成员 ↔ 太忆云 user_id 对齐
 *
 * 数据源: config/timem-team-registry.json
 * 职责:
 *   - 正向解析: 成员姓名/别名 → Member (含全部 timem_user_ids)
 *   - 反向归属: user_id → Member (记忆结果标注归属人)
 *   - 绑定管理: bind / unbind / add / remove (写回 JSON)
 *   - 未登记发现: observe() 记录搜索结果中出现但未登记的 user_id
 *
 * 纯逻辑, 不发网络请求 — 网络探测在 service.ts。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** 登记表中的一个团队成员 */
export interface TeamMember {
  /** 稳定英文短横线 id, 主键 */
  member_id: string;
  /** 显示名 (通常是中文名) */
  name: string;
  /** 别名: 英文名/花名/拼音/IM 显示名等, 查询时参与匹配 */
  aliases: string[];
  /** 绑定的太忆云 user_id (字符串, 可多个) */
  timem_user_ids: string[];
  role?: string;
  team?: string;
  email?: string;
  notes?: string;
}

export interface RegistryFile {
  version: number;
  updated_at: string;
  notes?: string[];
  members: TeamMember[];
}

/** 一次成员解析的结果: 精确命中 or 模糊候选 */
export type ResolveResult =
  | { kind: "exact"; member: TeamMember }
  | { kind: "ambiguous"; candidates: TeamMember[] }
  | { kind: "none" };

export class TeamRegistry {
  private file: RegistryFile;
  private readonly path: string;
  /** 搜索结果中观察到、但登记表里没有的 user_id → 出现次数 */
  private unknownSeen = new Map<string, number>();

  constructor(path: string) {
    this.path = path;
    this.file = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as RegistryFile)
      : { version: 1, updated_at: new Date().toISOString(), members: [] };
    if (!Array.isArray(this.file.members)) this.file.members = [];
  }

  get members(): readonly TeamMember[] {
    return this.file.members;
  }

  private persist(): void {
    this.file.updated_at = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(this.file, null, 2) + "\n", "utf8");
  }

  // ── 解析 ─────────────────────────────────────────────────────

  /** 成员姓名/别名 → 成员。先精确, 后包含式模糊 (大小写不敏感, 去空白) */
  resolve(rawName: string): ResolveResult {
    const q = normalize(rawName);
    if (!q) return { kind: "none" };

    for (const m of this.file.members) {
      if (m.member_id === rawName || normalize(m.name) === q) return { kind: "exact", member: m };
      if ((m.aliases ?? []).some((a) => normalize(a) === q)) return { kind: "exact", member: m };
    }
    const candidates = this.file.members.filter(
      (m) => normalize(m.name).includes(q) || (m.aliases ?? []).some((a) => normalize(a).includes(q)),
    );
    if (candidates.length === 1) return { kind: "exact", member: candidates[0] };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    return { kind: "none" };
  }

  /** user_id → 成员 (反向归属)。一个 user_id 只应绑定一个人; 多绑时返回第一个并视为配置错误 */
  findByUserId(userId: string | number): TeamMember | undefined {
    const id = String(userId);
    return this.file.members.find((m) => (m.timem_user_ids ?? []).includes(id));
  }

  /** 是否已登记 */
  isKnownUserId(userId: string | number): boolean {
    return this.findByUserId(userId) !== undefined;
  }

  // ── 绑定管理 ─────────────────────────────────────────────────

  /** 新增成员 */
  add(input: Omit<TeamMember, "timem_user_ids"> & { timem_user_ids?: (string | number)[] }): TeamMember {
    if (this.file.members.some((m) => m.member_id === input.member_id)) {
      throw new Error(`member_id 已存在: ${input.member_id}`);
    }
    const member: TeamMember = {
      ...input,
      aliases: input.aliases ?? [],
      timem_user_ids: (input.timem_user_ids ?? []).map(String),
    };
    this.file.members.push(member);
    this.persist();
    return member;
  }

  remove(memberId: string): boolean {
    const before = this.file.members.length;
    this.file.members = this.file.members.filter((m) => m.member_id !== memberId);
    if (this.file.members.length === before) return false;
    this.persist();
    return true;
  }

  /** 给成员绑定一个太忆云 user_id (幂等)。该 user_id 若已绑定他人则报错, 防串号 */
  bind(memberId: string, userId: string | number): void {
    const member = this.mustGet(memberId);
    const id = String(userId);
    const owner = this.findByUserId(id);
    if (owner && owner.member_id !== memberId) {
      throw new Error(`user_id ${id} 已绑定给 ${owner.name} (${owner.member_id}), 先 unbind 再改绑`);
    }
    if (!member.timem_user_ids.includes(id)) member.timem_user_ids.push(id);
    this.persist();
  }

  unbind(memberId: string, userId: string | number): void {
    const member = this.mustGet(memberId);
    member.timem_user_ids = member.timem_user_ids.filter((x) => x !== String(userId));
    this.persist();
  }

  /** 登记一个在云端观察到但未对齐的 user_id (内存态, 供 unknown 命令输出) */
  observeUnknown(userId: string | number): void {
    const id = String(userId);
    if (this.isKnownUserId(id)) return;
    this.unknownSeen.set(id, (this.unknownSeen.get(id) ?? 0) + 1);
  }

  get unknownUserIds(): [string, number][] {
    return [...this.unknownSeen.entries()];
  }

  mustGet(memberId: string): TeamMember {
    const m = this.file.members.find((x) => x.member_id === memberId);
    if (!m) throw new Error(`未找到成员: ${memberId}`);
    return m;
  }

  /** 全部已登记 user_id 的去重清单 */
  allUserIds(): string[] {
    return [...new Set(this.file.members.flatMap((m) => m.timem_user_ids ?? []))];
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}
