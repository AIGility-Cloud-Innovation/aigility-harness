/**
 * 智悦平台 · 角色能力注册表（DSH 渠道）
 *
 * 「给角色配 skill / MCP」的单一事实源：examples/feishu-dsh/roles.json。
 * 智能体工厂/角色管理保存配置 → 写入该文件 → dsh-interop session-relay
 * 每条消息热读取并生成 --patch overlay 注入 headless（改完即生效，无需重启）。
 *
 * 与 dsh-interop 的 RoleRegistry schema 对齐：
 *   { skillsRoot, roles: { <id>: {label?, skills[], mcpServers[]} }, routes: {<chatId|userId|appId>: roleId} }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 缺省指向 examples/feishu-dsh/roles.json（DSH 会话中继的热读取源）。
 *  模板化：部署方用 DSH_ROLE_REGISTRY 指向自己的注册表文件即可整体换家。 */
const REGISTRY_FILE =
  process.env.DSH_ROLE_REGISTRY ?? resolve(__dirname, "../../feishu-dsh/roles.json");

/** 注册表文件所在目录（roles.json 内相对路径的解析基准，保证模板可搬移） */
function registryDir(): string {
  return dirname(REGISTRY_FILE);
}

export interface RoleMcpServer {
  /** 模型侧工具命名空间 mcp__<serverName>__<rawName>，[A-Za-z0-9_-]{1,32} */
  serverName: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 提供url即视为 streamable-http 传输 */
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  failOnStartupError?: boolean;
}

export interface RoleCapabilityConfig {
  label?: string;
  /** 技能目录名（相对 skillsRoot）或绝对路径，目录内含 SKILL.md */
  skills?: string[];
  mcpServers?: RoleMcpServer[];
}

export interface RoleRegistryDoc {
  skillsRoot?: string;
  roles: Record<string, RoleCapabilityConfig>;
  routes: Record<string, string>;
  /** 保留未知顶层键（如 _说明），写回不丢 */
  [k: string]: unknown;
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function loadRoles(): RoleRegistryDoc {
  if (!existsSync(REGISTRY_FILE)) {
    return { roles: {}, routes: {} };
  }
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8")) as RoleRegistryDoc;
    return { ...raw, roles: raw.roles ?? {}, routes: raw.routes ?? {} };
  } catch (e) {
    console.warn("[role-registry] 读取失败（返回空表，不覆盖文件）:", e);
    return { roles: {}, routes: {} };
  }
}

function persist(doc: RoleRegistryDoc): void {
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

/** 校验并规整一个角色配置；返回错误消息或 null（通过） */
export function validateRole(input: Partial<RoleCapabilityConfig>): string | null {
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.some((s) => typeof s !== "string")) {
      return "skills 必须是字符串数组（技能目录名或绝对路径）";
    }
  }
  if (input.mcpServers !== undefined) {
    if (!Array.isArray(input.mcpServers)) return "mcpServers 必须是数组";
    for (const s of input.mcpServers) {
      if (!s || typeof s.serverName !== "string" || !SERVER_NAME_RE.test(s.serverName)) {
        return `mcpServers[].serverName 必须匹配 [A-Za-z0-9_-]{1,32}（got: ${String(s?.serverName)}）`;
      }
      const isHttp = typeof s.url === "string" && s.url.length > 0;
      const isStdio = typeof s.command === "string" && s.command.length > 0;
      if (!isHttp && !isStdio) {
        return `mcpServers[${s.serverName}] 需要 url（streamable-http）或 command（stdio）二选一`;
      }
      if (isHttp && isStdio) {
        return `mcpServers[${s.serverName}] url 与 command 只能二选一`;
      }
    }
  }
  return null;
}

/** 新增/更新角色；同 id 覆盖。非法输入抛错（调用方转 400） */
export function upsertRole(
  id: string,
  input: { label?: string; skills?: string[]; mcpServers?: RoleMcpServer[] },
): RoleCapabilityConfig {
  const problem = validateRole(input);
  if (problem) throw new Error(problem);
  if (!/^[\w.-]{1,64}$/.test(id)) throw new Error("角色 id 只允许字母数字._-（1-64 位）");
  const doc = loadRoles();
  const config: RoleCapabilityConfig = {};
  if (input.label !== undefined) config.label = String(input.label);
  if (input.skills !== undefined) config.skills = input.skills;
  if (input.mcpServers !== undefined) {
    config.mcpServers = input.mcpServers.map((s) =>
      s.url
        ? {
            serverName: s.serverName,
            url: s.url,
            ...(s.headers ? { headers: s.headers } : {}),
            ...(s.failOnStartupError !== undefined ? { failOnStartupError: s.failOnStartupError } : {}),
          }
        : {
            serverName: s.serverName,
            command: s.command,
            ...(s.args?.length ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
            ...(s.cwd ? { cwd: s.cwd } : {}),
            ...(s.failOnStartupError !== undefined ? { failOnStartupError: s.failOnStartupError } : {}),
          },
    );
  }
  doc.roles[id] = config;
  persist(doc);
  return config;
}

export function removeRole(id: string): boolean {
  const doc = loadRoles();
  if (!(id in doc.roles)) return false;
  delete doc.roles[id];
  // 级联清理指向该角色的路由
  for (const [k, v] of Object.entries(doc.routes)) {
    if (v === id) delete doc.routes[k];
  }
  persist(doc);
  return true;
}

/** 设置/删除路由映射（roleId 为空串表示删除该路由） */
export function setRoute(chatKey: string, roleId: string): void {
  const doc = loadRoles();
  if (roleId) {
    if (!(roleId in doc.roles)) throw new Error(`角色 "${roleId}" 不存在，请先创建`);
    doc.routes[chatKey] = roleId;
  } else {
    delete doc.routes[chatKey];
  }
  persist(doc);
}

/** 技能路径存在性体检（供 UI 标红不存在的目录；不阻断保存） */
export function checkSkillPaths(doc: RoleRegistryDoc): Record<string, string[]> {
  // 基准与货架枚举一致：skillsRootDir()（相对 skillsRoot 以注册表文件所在目录为基准）
  const root = skillsRootDir();
  const out: Record<string, string[]> = {};
  for (const [id, cfg] of Object.entries(doc.roles)) {
    const missing = (cfg.skills ?? [])
      .map((s) => (isAbsolute(s) ? s : resolve(root, s)))
      .filter((p) => !existsSync(p));
    if (missing.length > 0) out[id] = missing;
  }
  return out;
}

// ── DSH 技能货架：skillsRoot 下的技能目录（含 SKILL.md frontmatter 解析） ──

export interface DshSkillInfo {
  /** 相对 skillsRoot 的目录名（roles.skills 填这个即可） */
  dir: string;
  name: string;
  description: string;
  /** SKILL.md 完整路径（预览用） */
  path: string;
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (km) out[km[1] as "name" | "description"] = km[2].replace(/^["'>-]+|["']$/g, "").trim() || undefined;
  }
  // description 的 YAML 折叠多行（>-）：抓取下一行起缩进文本
  if (!out.description && /description:\s*>-/.test(m[1])) {
    const lines = m[1].split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim().startsWith("description:"));
    const cont: string[] = [];
    for (let j = i + 1; j < lines.length && (lines[j].startsWith("  ") || lines[j].trim() === ""); j++) {
      if (lines[j].trim()) cont.push(lines[j].trim());
    }
    out.description = cont.join(" ");
  }
  return out;
}

export function skillsRootDir(): string {
  // 优先级：环境变量 > roles.json 内的 skillsRoot（相对路径以注册表文件所在目录为基准）> 注册表旁的 skills/ 目录
  const env = process.env.DSH_SKILLS_ROOT;
  if (env) return resolve(env);
  const doc = loadRoles();
  if (doc.skillsRoot) {
    return isAbsolute(doc.skillsRoot) ? doc.skillsRoot : resolve(registryDir(), doc.skillsRoot);
  }
  return resolve(registryDir(), "skills");
}

/** 枚举 DSH 技能货架（skillsRoot 下含 SKILL.md 的一级目录） */
export function listDshSkills(): DshSkillInfo[] {
  const root = skillsRootDir();
  if (!existsSync(root)) return [];
  const out: DshSkillInfo[] = [];
  for (const dir of readdirSync(root)) {
    const md = resolve(root, dir, "SKILL.md");
    if (!statSync(resolve(root, dir)).isDirectory() || !existsSync(md)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(md, "utf-8"));
      out.push({ dir, name: fm.name ?? dir, description: fm.description ?? "", path: md });
    } catch { /* 单个技能损坏不拖垮列表 */ }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** 创建 DSH 技能目录（SKILL.md）：工厂发布「同步为 DSH 技能」的落点 */
export function createDshSkill(input: { name: string; description: string; prompt: string }): DshSkillInfo {
  const slug =
    input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) ||
    `skill-${Date.now().toString(36)}`;
  if (!SLUG_RE.test(slug)) throw new Error("技能名无法生成合法目录名（需字母数字连字符）");
  const root = skillsRootDir();
  const dir = resolve(root, slug);
  if (existsSync(dir)) throw new Error(`技能目录已存在: ${slug}`);
  const md = [
    "---",
    `name: ${slug}`,
    "description: >-",
    `  ${input.description.replace(/\s+/g, " ").slice(0, 200)}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    input.prompt.trim(),
    "",
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), md, "utf-8");
  return { dir: slug, name: slug, description: input.description, path: resolve(dir, "SKILL.md") };
}

/** 把技能挂到角色（追加去重） */
export function attachSkillToRole(roleId: string, skillRef: string): RoleCapabilityConfig {
  const doc = loadRoles();
  if (!doc.roles[roleId]) throw new Error(`角色 "${roleId}" 不存在`);
  const cfg = doc.roles[roleId];
  const skills = cfg.skills ?? [];
  if (!skills.includes(skillRef)) skills.push(skillRef);
  cfg.skills = skills;
  persist(doc);
  return cfg;
}

// ── MCP 货架：全角色 mcpServers 按 serverName 聚合去重 ──────────────

export interface McpShelfItem extends RoleMcpServer {
  /** 引用此配置的角色 id 列表 */
  usedBy: string[];
}

export function listMcpShelf(): McpShelfItem[] {
  const doc = loadRoles();
  const byName = new Map<string, McpShelfItem>();
  for (const [roleId, cfg] of Object.entries(doc.roles)) {
    for (const s of cfg.mcpServers ?? []) {
      const found = byName.get(s.serverName);
      if (found) {
        if (!found.usedBy.includes(roleId)) found.usedBy.push(roleId);
      } else {
        byName.set(s.serverName, { ...s, usedBy: [roleId] });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.serverName.localeCompare(b.serverName));
}
