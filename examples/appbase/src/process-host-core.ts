/**
 * 应用进程宿主 · 纯函数核心 (无 IO 依赖, 可独立单测)
 *
 * 宿主本体见 process-host.ts; 这里只放决策/换算逻辑:
 * 启动命令的 spawn 环境合并、cwd 解析、孤儿收编判定、env 脱敏、插件清单规整。
 */

/** app_processes 行的形状 (DB 读出; JSONB 字段已解析) */
export interface ProcRowLike {
  app_id: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  port: number | null;
  required_plugins: string[];
  desired_state: string;
  pid: number | null;
}

/** 平台进程环境 + 应用自有 env 合并: 继承平台全量 env (含插件 env 桥产物
 *  如 TIMEM_API_KEY), 应用 env 同名覆盖。 */
export function mergeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  appEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...(appEnv ?? {}) };
}

/** cwd 解析: 绝对路径原样; 相对路径相对仓库根 (注册表里存仓库根相对路径, 便于换机) */
export function resolveCwd(cwd: string, repoRoot: string): string {
  const t = String(cwd ?? "").trim();
  if (!t) return repoRoot;
  return isAbsolutePath(t) ? t : joinPath(repoRoot, t);
}

/** 路径绝对性判定 (win32 盘符 + posix 根); 不 import node:path 便于纯测 */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\)/.test(p);
}

/** 简单 path join (纯函数; 只用于 cwd 拼接, 分隔符跟随 repoRoot 尾字符风格) */
export function joinPath(root: string, sub: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const r = root.replace(/[\\/]+$/, "");
  return r + sep + String(sub).replace(/^[\\/]+/, "");
}

/** pid 存活探测: kill(pid,0) — EPERM 视为存活 (他人进程), ESRCH 为不存在 */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** 平台重启后的启动决策: 端口在听优先 (服务级真相), 回落 DB pid 存活, 否则拉起 */
export function decideAdopt(opts: { portListening: boolean; pidAlive: boolean }): "adopt" | "spawn" {
  return opts.portListening || opts.pidAlive ? "adopt" : "spawn";
}

/** 宿主视角的状态归类: 与 UI 徽标一一对应 */
export function classifyStatus(opts: {
  childAlive: boolean;
  portListening: boolean;
  pidAlive: boolean;
  desiredState: string;
}): "running" | "adopted" | "exited" | "stopped" {
  if (opts.childAlive) return "running";
  if (opts.portListening || opts.pidAlive) return "adopted";
  return opts.desiredState === "running" ? "exited" : "stopped";
}

/** env 脱敏: 键名含 token/secret/password/key 的值打码 (列表接口不回明文) */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = /pass|secret|token|key/i.test(k) ? "••••" : String(v);
  }
  return out;
}

/** 依赖插件清单规整: 接受数组或逗号分隔串, 去空白去重 */
export function parsePluginList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(String) : String(v ?? "").split(",");
  const out: string[] = [];
  for (const item of raw) {
    const t = item.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 依赖插件就绪对照: 对照 dshStatus().plugins 形状 (出现且无 error = mounted) */
export function pluginReadiness(
  required: string[],
  mountedPlugins: Record<string, { error?: string } | undefined>,
): Array<{ name: string; mounted: boolean; error?: string }> {
  return (required ?? []).map((name) => {
    const rec = mountedPlugins?.[name];
    return { name, mounted: Boolean(rec) && !rec?.error, error: rec?.error };
  });
}
