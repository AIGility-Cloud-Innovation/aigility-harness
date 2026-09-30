/**
 * 项目对齐登记表 (project registry) — 飞书群 / 任务清单 / Gitea 仓库 / 运维日志 的项目归属
 *
 * 数据源: config/project-registry.json（$schema 见同目录 .schema.md）
 * 目标：同一个项目在这几个数据来源中是同一个项目。
 * 飞书任务清单不单独登记——沿用既有约定「一个 Gitea 组织 = 一个清单」
 * （task-issue-sync tasklistNameForRepo），任务标题 [org/repo#N] 前缀反查仓库。
 *
 * 项目级 timem 记忆的虚拟用户键 = `project:<project_id>`（写入与召回都用它，
 * 配合 agent_id=feishu-task-assistant 与 domain=project_id）。
 */

import { createRegistryReader, findRepoConfigFile } from "./registry-util.js";

export interface ProjectLogSource {
  /** 日志服务地址（log-monitor 拉取用，如 http://140.143.155.105:19434） */
  host: string;
  /** log-monitor 项目键 p */
  p: string;
  /** log-monitor 服务名 s */
  s: string;
}

export interface ProjectEntry {
  project_id: string;
  name: string;
  aliases?: string[];
  gitea_repos?: string[];
  /** 整组织项目：briefing 时经 /orgs/{org}/repos 动态展开 */
  gitea_orgs?: string[];
  feishu_chat_ids?: string[];
  log_sources?: ProjectLogSource[];
}

export interface ProjectRegistryFile {
  version: number;
  updated_at: string;
  notes?: string[];
  projects: ProjectEntry[];
}

function emptyProjectRegistry(): ProjectRegistryFile {
  return { version: 1, updated_at: new Date().toISOString(), projects: [] };
}

const readRegistry = createRegistryReader<ProjectRegistryFile>("project-registry.json", emptyProjectRegistry);

/** 读项目登记表（env PROJECT_REGISTRY_PATH 可覆盖路径；平台改文件后自动生效） */
export function getProjectRegistry(pathOverride?: string): ProjectRegistryFile {
  const file = readRegistry(pathOverride ?? projectRegistryPath());
  if (!Array.isArray(file.projects)) file.projects = [];
  return file;
}

export function projectRegistryPath(): string | undefined {
  return process.env.PROJECT_REGISTRY_PATH || findRepoConfigFile("project-registry.json");
}

// ── 解析 ─────────────────────────────────────────────────────────

/** 群 chatId → 项目（群消息归属判定用） */
export function findProjectByChatId(file: ProjectRegistryFile, chatId: string): ProjectEntry | undefined {
  if (!chatId) return undefined;
  return file.projects.find((p) => (p.feishu_chat_ids ?? []).includes(chatId));
}

/** 仓库 full_name → 项目（含整组织项目：org 段命中 gitea_orgs） */
export function findProjectByRepo(file: ProjectRegistryFile, repoFullName: string): ProjectEntry | undefined {
  const repo = repoFullName.trim();
  if (!repo) return undefined;
  const direct = file.projects.find((p) => (p.gitea_repos ?? []).includes(repo));
  if (direct) return direct;
  const org = repo.split("/")[0] ?? "";
  return file.projects.find((p) => (p.gitea_orgs ?? []).includes(org));
}

/** 项目 id / 名称 / 别名 → 项目（先精确后包含；歧义时返回 undefined 并把候选放进第二返回值） */
export function resolveProjectRef(
  file: ProjectRegistryFile,
  query?: string,
): { project?: ProjectEntry; ambiguous?: ProjectEntry[] } {
  if (!query || !query.trim()) return {};
  const q = query.trim().toLowerCase();
  const projects = file.projects;
  for (const p of projects) {
    if (p.project_id.toLowerCase() === q || p.name.toLowerCase() === q) return { project: p };
    if ((p.aliases ?? []).some((a) => a.toLowerCase() === q)) return { project: p };
  }
  const hit = projects.filter(
    (p) =>
      p.project_id.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      (p.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  );
  if (hit.length === 1) return { project: hit[0] };
  if (hit.length > 1) return { ambiguous: hit };
  return {};
}

/** 项目覆盖的仓库与组织（org 由调用方经 API 展开为仓库） */
export function projectRepoScope(p: ProjectEntry): { repos: string[]; orgs: string[] } {
  return { repos: [...(p.gitea_repos ?? [])], orgs: [...(p.gitea_orgs ?? [])] };
}

/** 项目级 timem 记忆的虚拟用户键 */
export function projectMemoryUserKey(projectId: string): string {
  return `project:${projectId}`;
}

/** 登记表里出现过的全部组织（去重）——自动匹配候选拉取用 */
export function registryOrgs(file: ProjectRegistryFile): string[] {
  const orgs = new Set<string>();
  for (const p of file.projects) {
    for (const r of p.gitea_repos ?? []) orgs.add(r.split("/")[0]);
    for (const o of p.gitea_orgs ?? []) orgs.add(o);
  }
  return [...orgs].filter(Boolean);
}
