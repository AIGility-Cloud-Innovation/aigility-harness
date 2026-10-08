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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    /** 记忆策略声明位（Letta 式自治的声明面；运行时按声明执行，缺省平台代管）：
     *  retention: 记忆保留范围；teamMemory: 加入智能体小队共享的团队记忆 */
    strategy?: {
      retention?: "long-term" | "session";
      teamMemory?: boolean;
      /** 归纳节奏（如 daily-digest），对齐 project-briefing 快照机制 */
      digest?: string;
    };
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

// ── M-B 应用级人设校验（copy-on-override 写入前）──────────────────
// 站点副本是应用层事实源：存根/退化副本一旦写入，会以"站点优先"压掉出厂模板
// （sales-chat 已是历史实例）。故写入前做三重校验，失败即拒绝。

/** 站点副本的占位标记（出厂模板存根曾经用过） */
const PLACEHOLDER_MARKERS = ["定制副本：在此撰写完整人设", "人设待补", "在此撰写完整人设"];

/** 归一化正文：去 frontmatter 残留、统一换行、压缩空白（比对"是否退化"用） */
export function normalizePersonaBody(md: string): string {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** M-B 校验结果：issues 非空即拒绝写入 */
export interface PersonaValidation {
  ok: boolean;
  issues: string[];
  /** 归一化后的正文字符数（供 UI 提示） */
  bodyLength: number;
}

/**
 * 站点副本写入前校验（persona 三级 M-B）：非空 / 非退化 / 非占位。
 *
 * @param body        拟写入的 SKILL.md 正文（可含 frontmatter，内部会剥离）
 * @param templateBody 出厂模板正文（同 id 公共角色；无则跳过"非退化"一项）
 */
export function validateSitePersona(body: string, templateBody?: string): PersonaValidation {
  const issues: string[] = [];
  const normalized = normalizePersonaBody(body);
  const bodyLength = normalized.length;

  // ① 非空：剥离 frontmatter/空行后正文 ≥ 80 字符
  if (bodyLength < 80) {
    issues.push(`人设正文过短（${bodyLength} 字符 < 80）：站点副本必须是可用的完整人设`);
  }
  // ② 非占位：不得含存根占位标记
  const hit = PLACEHOLDER_MARKERS.find((mk) => body.includes(mk));
  if (hit) issues.push(`人设含占位标记「${hit}」：请撰写完整人设后再保存`);
  // ③ 非退化：与出厂模板正文归一化后必须不同（禁用"存根/原文原样复制"）
  if (templateBody !== undefined) {
    const tpl = normalizePersonaBody(templateBody);
    if (tpl && normalized === tpl) {
      issues.push("站点副本与出厂模板正文完全相同（退化复制）：站点化应体现差异化定制");
    }
  }
  return { ok: issues.length === 0, issues, bodyLength };
}

// ── M-C 提升回流（站点 → 出厂模板）──────────────────────────────
// 三级生命周期的收口环节：站点副本（应用级）调好之后，管理员把它提升回
// 出厂模板（packages/role-kit/roles/<id>/SKILL.md），走 git PR 人审后随版本分发。
//
// 纪律（负责人 §4-2 拍板）：
//   - 权限：平台 isAdmin（非框架维护者通道，维护者在 git PR 合入时把关）；
//   - 校验：沿用 M-B 的非退化/非空/非占位（提升物不能是存根或模板的复制品）；
//   - 留痕：写审计 role.promote。
// 本模块只产出"待写回内容"（纯函数，无 IO），写盘与权限由调用方（平台端点）负责。

/** 站点副本提升为出厂模板所需的素材 */
export interface RolePromotion {
  roleId: string;
  /** 待写回的完整 SKILL.md 文本（保留站点副本的 frontmatter，正文以站点为准） */
  content: string;
  /** 提升后入库的 SKILL.md 相对路径（仓库内，供审计与 PR 说明展示） */
  target: string;
  /** 归一化后的正文字符数 */
  bodyLength: number;
}

/** 提升前置校验结果：issues 非空即拒绝提升 */
export interface PromotionCheck extends PersonaValidation {
  /** 站点副本与出厂模板正文归一化后是否相同（相同 = 无提升价值/退化） */
  identicalToTemplate: boolean;
  /** 出厂模板是否已存在该角色（不存在 = 首次沉淀，非"提升"） */
  templateExists: boolean;
}

/**
 * 提升前置校验（M-C）：站点副本相对出厂模板必须是"实质推进"。
 *
 * 与 M-B 的差别：M-B 拦"写入站点的存根"，M-C 拦"把无差异的东西提升回模板"。
 * 因此这里**强制要求存在出厂模板且正文确有差异**——没有差异就没有可回流的信息，
 * 否则一次误点就会在 git 里产生一个空 PR。
 */
export function checkPromotion(siteBody: string, templateBody: string | undefined): PromotionCheck {
  const base = validateSitePersona(siteBody, templateBody);
  const issues = [...base.issues];
  const templateExists = templateBody !== undefined && normalizePersonaBody(templateBody).length > 0;
  const identicalToTemplate =
    templateExists && normalizePersonaBody(siteBody) === normalizePersonaBody(templateBody);
  if (identicalToTemplate && !issues.includes(PROMOTION_IDENTICAL_ISSUE)) {
    issues.push(PROMOTION_IDENTICAL_ISSUE);
  }
  return { ...base, ok: issues.length === 0, issues, identicalToTemplate, templateExists };
}

/** 「无差异」问题的稳定文案（端点与 UI 共用，避免两处漂移） */
export const PROMOTION_IDENTICAL_ISSUE =
  "站点副本与出厂模板正文无差异：没有可回流的内容（请先定制再提升）";

/**
 * 渲染待提升的 SKILL.md（M-C）：站点正文 + 目标角色包的既有 frontmatter。
 *
 * 为何复用**目标模板**的 frontmatter 而非站点副本的：出厂模板的 `name` 是英文
 * role.id（§1 迁移口径），站点副本可能仍是中文显示名；提升回模板时必须落回
 * 出厂口径，否则会把站点显示名带进公共层（§1 迁移项 ① 的回归）。
 * 模板不存在时（首次沉淀）用 role.id 生成最小 frontmatter。
 *
 * @param roleId       角色 id（= 目录名 = 模板文件名基准）
 * @param siteBody     站点副本正文（可含 frontmatter，内部只取正文）
 * @param templateSkillMd 目标模板现有 SKILL.md 全文（不存在传 undefined）
 */
export function renderPromotedSkillMd(
  roleId: string,
  siteBody: string,
  templateSkillMd?: string,
): string {
  const body = normalizePersonaBody(siteBody);
  const fm = templateSkillMd
    ? /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(templateSkillMd)?.[0]?.trimEnd()
    : undefined;
  const frontmatter = fm ?? `---\nname: ${roleId}\ndescription: 出厂模板（管理员提升）\n---`;
  return `${frontmatter}\n\n${body}\n`;
}

/**
 * 组装提升物（M-C）：校验通过才返回，否则返回 issues 供端点回 400。
 *
 * @param roleId 角色 id
 * @param siteBody 站点副本正文
 * @param templateSkillMd 目标出厂模板 SKILL.md 全文（不存在传 undefined）
 * @param templatesDir 出厂模板根目录绝对路径（bundledRolesDir() 或调用方自定；仅用于拼 target 展示路径）
 */
export function buildPromotion(
  roleId: string,
  siteBody: string,
  templateSkillMd: string | undefined,
  templatesDir: string,
): { ok: true; promotion: RolePromotion } | { ok: false; issues: string[] } {
  const templateBody = templateSkillMd
    ? (() => {
        const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(templateSkillMd);
        return (m ? templateSkillMd.slice(m[0].length) : templateSkillMd).trim();
      })()
    : undefined;
  const check = checkPromotion(siteBody, templateBody);
  if (!check.ok) return { ok: false, issues: check.issues };
  const content = renderPromotedSkillMd(roleId, siteBody, templateSkillMd);
  return {
    ok: true,
    promotion: {
      roleId,
      content,
      target: join(templatesDir, roleId, "SKILL.md"),
      bodyLength: normalizePersonaBody(siteBody).length,
    },
  };
}

// ── 出厂模板目录 ────────────────────────────────────────────────
// 随 role-kit 包分发的公共角色模板（packages/role-kit/roles/，git 版本化）；
// 站点事实源在各站 data/roles/（siteDirs，同 id 站点优先），模板永远只读分发。
const KIT_ROOT = dirname(fileURLToPath(import.meta.url));

/** 出厂模板目录绝对路径（调用方作为 publicDir 传入 loadRolePackages） */
export function bundledRolesDir(): string {
  return resolve(KIT_ROOT, "../roles");
}

// ── ElizaOS character file 兼容层 ───────────────────────────────
// 设计哲学对齐（2026-10 生态调研）：ElizaOS 以 character file 为"最重要的单一产物"，
// 本转换器让角色包能与其格式互通（导出传播 / 导入安装）。转换是尽力而为的映射：
// 人设主旨走 bio + system（后者为常见扩展字段），能力声明走 plugins/knowledge。

/**
 * ElizaOS Character —— 对齐 @elizaos/core@1.7.2 已发布 schema（dist/types/agent.d.ts）的结构类型。
 * 为何 vendor 而非 import type：实测该包 1.7.2 的类型发布损坏——exports["."].types 指向的
 * dist/index.d.ts star-export 链解析为空，"./node" 子路径的 index.d.ts 指向无类型的 index.node.js。
 * 待上游修复后改回 `import type { Character } from "@elizaos/core"`（运行时零依赖不变）。
 */
export interface ElizaCharacter {
  name: string;
  /** 官方可选 system prompt 字段 */
  system?: string;
  bio: string | string[];
  knowledge?: (string | { path: string; shared?: boolean })[];
  plugins?: string[];
  topics?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  settings?: { [key: string]: string | boolean | number | Record<string, unknown> };
  messageExamples?: unknown[][];
  postExamples?: string[];
  adjectives?: string[];
  id?: string;
  username?: string;
  templates?: { [key: string]: unknown };
  secrets?: { [key: string]: string | boolean | number };
}

/** 角色包 → ElizaOS character file（字段映射：人设主旨→bio+system，能力→plugins，数据→knowledge；
 *  溯源放 settings.aigility —— settings 有索引签名，可安全携带回转字段） */
export function toElizaCharacter(pkg: {
  id: string;
  name: string;
  description: string;
  prompt: string;
  manifest: RoleManifest;
}): ElizaCharacter {
  const bio = [pkg.description, ...pkg.prompt.split(/\n\n/).slice(0, 2)].filter(Boolean);
  const character: ElizaCharacter = {
    name: pkg.name || pkg.id,
    bio: bio.length ? bio : [pkg.id],
  };
  if (pkg.prompt) character.system = pkg.prompt;
  if (pkg.manifest.sources?.data?.length) character.knowledge = [...pkg.manifest.sources.data];
  if (pkg.manifest.actions?.tools?.length) character.plugins = [...pkg.manifest.actions.tools];
  character.settings = {
    aigility: {
      role_id: pkg.id,
      memory_agent_id: pkg.manifest.memory?.agent_id ?? pkg.id,
      ...(pkg.manifest.identity?.capability_ref ? { capability_ref: pkg.manifest.identity.capability_ref } : {}),
    },
  };
  return character;
}

/** ElizaOS character file → 角色包（manifest + prompt）；不合法返回 null */
export function fromElizaCharacter(
  char: ElizaCharacter | Record<string, unknown>,
): { manifest: RoleManifest; prompt: string } | null {
  const c = char as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  if (!name) return null;
  const settings = (c.settings ?? {}) as { aigility?: { role_id?: string; memory_agent_id?: string; capability_ref?: string } };
  const aig = settings.aigility ?? {};
  const roleId = typeof aig.role_id === "string" && aig.role_id ? aig.role_id : name.toLowerCase().replace(/\s+/g, "-");
  const bio = Array.isArray(char.bio) ? char.bio.filter((x: unknown) => typeof x === "string").join("\n") : typeof char.bio === "string" ? char.bio : "";
  const system = typeof char.system === "string" ? char.system : "";
  const prompt = (system || bio).trim();
  const plugins = Array.isArray(char.plugins) ? char.plugins.filter((x: unknown) => typeof x === "string") : [];
  const knowledge = Array.isArray(char.knowledge) ? char.knowledge.filter((x: unknown) => typeof x === "string") : [];
  // 基线 3/4：记忆域恒 = role_id。换 id 导入（分享副本）时记忆域跟随新 id，
  // 源角色的记忆域如实登记 legacy（不与源共享记忆，防止误读他人记忆）。
  const memAgent = typeof aig.memory_agent_id === "string" ? aig.memory_agent_id : roleId;
  const manifest: RoleManifest = {
    role_id: roleId,
    identity: { name, ...(typeof aig.capability_ref === "string" ? { capability_ref: aig.capability_ref } : {}) },
    sources: { ...(knowledge.length ? { data: knowledge } : {}) },
    actions: { ...(plugins.length ? { tools: plugins } : {}) },
    outbound: {},
    memory: { agent_id: roleId, ...(memAgent !== roleId ? { legacy_agent_ids: [memAgent] } : {}) },
  };
  return { manifest, prompt };
}
