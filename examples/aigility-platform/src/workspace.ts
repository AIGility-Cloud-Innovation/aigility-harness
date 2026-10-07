/**
 * 本地工作区（服务端目录授权）—— 数字员工对话页「本地使用的工作区选择」的数据源
 *
 * 语义（对齐 dsh-web 的 workspace / directory-picker，但落地为平台自有实现）：
 *   - 工作区 = 服务端（跑平台的那台机器）上的一个本地目录，是数字员工被授权
 *     读写文件的**范围**；对话请求携带 workspace 后，agent 把它作为能力边界
 *     注入人设（真实文件读写由已安装的工具插件执行，本模块只做目录授权与选择）。
 *   - 根目录白名单（AIGILITY_WORKSPACE_ROOTS，逗号分隔）：缺省 = 用户主目录、
 *     仓库根、/tmp —— 数字员工只允许在这几个树内选择工作区，防目录穿越。
 *   - 安全：所有路径先 realpath 再校验前缀；符号链接解析后不得逃出白名单根。
 */

import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { realpathSync, existsSync, statSync, readdirSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 仓库根 = examples/aigility-platform/src → ../../.. → aigility-harness
const REPO_ROOT = resolve(__dirname, "../../..");

/** 缺省白名单根（env AIGILITY_WORKSPACE_ROOTS 可覆盖/追加） */
function defaultRoots(): string[] {
  const envRoots = (process.env.AIGILITY_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [homedir(), REPO_ROOT, "/tmp", ...envRoots];
  // 去重且只保留存在项
  return [...new Set(out)].filter((p) => {
    try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
  });
}

export interface WorkspaceRoot {
  path: string;
  label: string;
  /** true = 当前会话可读（root 级访问探测） */
  readable: boolean;
  writable: boolean;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  isDir: boolean;
  readable: boolean;
  writable: boolean;
  /** 是否 git 仓库根（供「工作区」语义展示） */
  isGitRoot: boolean;
}

export interface WorkspaceBrowse {
  ok: boolean;
  path: string;
  parent: string | null;
  root: string | null;
  entries: WorkspaceEntry[];
  error?: string;
}

/** 归一化白名单根列表（realpath 后缓存） */
let _rootsCache: WorkspaceRoot[] | null = null;
export function workspaceRoots(force = false): WorkspaceRoot[] {
  if (_rootsCache && !force) return _rootsCache;
  const roots = defaultRoots().map((p) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* 保留原路径 */ }
    let readable = false, writable = false;
    try { accessSync(real, constants.R_OK); readable = true; } catch { /* 不可读 */ }
    try { accessSync(real, constants.W_OK); writable = true; } catch { /* 不可写 */ }
    return { path: real, label: real === REPO_ROOT ? "智悦仓库" : basename(real) || real, readable, writable };
  });
  _rootsCache = roots;
  return roots;
}

/** 判定路径是否落在任一白名单根内（realpath 后前缀校验，防穿越） */
export function resolveWorkspace(path: string): { ok: boolean; path?: string; root?: WorkspaceRoot; error?: string } {
  const trimmed = path.trim();
  if (!trimmed) return { ok: false, error: "路径为空" };
  let real: string;
  try {
    real = realpathSync(trimmed);
  } catch (e) {
    return { ok: false, error: `路径不可达：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, error: "工作区必须是目录" };
  } catch (e) {
    return { ok: false, error: `目录校验失败：${e instanceof Error ? e.message : String(e)}` };
  }
  for (const root of workspaceRoots()) {
    const r = root.path.endsWith("/") ? root.path : root.path + "/";
    if (real === root.path || real.startsWith(r)) {
      return { ok: true, path: real, root };
    }
  }
  return { ok: false, error: "该目录不在允许的工作区根内（白名单：用户主目录 / 智悦仓库 / /tmp）" };
}

/** 浏览一个目录：只列子目录（工作区选择是目录级语义），按名称排序 */
export function browseWorkspace(path: string): WorkspaceBrowse {
  const resolved = resolveWorkspace(path);
  if (!resolved.ok || !resolved.path || !resolved.root) {
    return { ok: false, path, parent: null, root: null, entries: [], error: resolved.error };
  }
  const real = resolved.path;
  const rootPath = resolved.root.path;
  let names: string[] = [];
  try {
    names = readdirSync(real).filter((n) => {
      try { return statSync(resolve(real, n)).isDirectory(); } catch { return false; }
    });
  } catch (e) {
    return { ok: false, path: real, parent: null, root: rootPath, entries: [], error: `目录不可读：${e instanceof Error ? e.message : String(e)}` };
  }
  names.sort((a, b) => a.localeCompare(b, "zh-CN"));
  const entries: WorkspaceEntry[] = names.map((n) => {
    const full = resolve(real, n);
    let readable = false, writable = false, isGitRoot = false;
    try {
      accessSync(full, constants.R_OK); readable = true;
      accessSync(full, constants.W_OK); writable = true;
    } catch { /* 权限不足保持 false */ }
    try { isGitRoot = existsSync(resolve(full, ".git")); } catch { /* 无 */ }
    return { name: n, path: full, isDir: true, readable, writable, isGitRoot };
  });
  // 父目录：不出白名单根时给上一级，否则 null
  const parent = real === rootPath ? null : (resolveWorkspace(dirname(real)).ok ? dirname(real) : null);
  return { ok: true, path: real, parent, root: rootPath, entries };
}
