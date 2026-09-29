/**
 * dshSessionRelay — IM 消息 → 官方 dsh headless agent 的会话中继原语。
 *
 * 抽自 examples/wecom-dsh 与 examples/feishu-dsh 的重复实现（二者此前逐行
 * 相同）：各 IM 装配（wecom/feishu/钉钉…）只需提供「取文本 + 取会话 id」
 * 的 glue，多轮记忆、headless 调用、指令处理、回复截断全部收敛于此。
 *
 * headless runner 每次调用都新建会话（session-<uuid>，见 dsh-headless 源码），
 * CLI 无 --resume（那是 tui/web 的旗标）；多轮记忆由 TranscriptStore 以滚动
 * 上下文注入实现，历史落盘 JSON，重启不丢。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LayerId, PluginState, ok, err } from "@aigility-harness/core";
import type {
  CapabilityRef,
  HealthStatus,
  Provider,
  Result,
  ServiceDefinition,
  SeamContext,
} from "@aigility-harness/core";

const localRequire = createRequire(import.meta.url);

// ── 角色能力注册表（Phase 2：role → skills/MCP 注入 headless） ────

/** 一个 MCP server 的连接配置（对应 @deepseek-ai/dsh-mcp-client 的 Config） */
export interface RoleMcpServer {
  /** 模型侧工具命名空间（mcp__<serverName>__<rawName>），[A-Za-z0-9_-]{1,32} */
  serverName: string;
  /** stdio: 可执行文件 */
  command?: string;
  /** stdio: 参数 */
  args?: string[];
  /** stdio: 额外环境变量 */
  env?: Record<string, string>;
  /** stdio: 工作目录 */
  cwd?: string;
  /** streamable-http: 端点 URL（提供 url 即视为 http 传输） */
  url?: string;
  /** streamable-http: 附加请求头 */
  headers?: Record<string, string>;
  /** 单次工具调用超时 ms */
  toolCallTimeoutMs?: number;
  /** 首连失败是否让插件激活失败（默认 false：不影响会话启动） */
  failOnStartupError?: boolean;
}

/** 单个角色的能力配置 */
export interface RoleCapabilityConfig {
  /** 展示名 */
  label?: string;
  /** 技能目录名列表（相对 skillsRoot，目录内含 SKILL.md） */
  skills?: string[];
  /** MCP server 列表 */
  mcpServers?: RoleMcpServer[];
}

/** 角色能力注册表文件结构（每条消息重新读取：改完即热生效） */
export interface RoleRegistry {
  /** 技能根目录（roles.*.skills 的相对基准） */
  skillsRoot: string;
  /** 角色 id → 能力配置 */
  roles: Record<string, RoleCapabilityConfig>;
  /** 飞书 chatId/userId/appId → 角色 id；未命中走 default */
  routes: Record<string, string>;
}

/** 读取角色注册表（文件不存在/损坏返回 null，由调用方降级为不注入）。
 *  模板化：相对的 skillsRoot 以注册表文件所在目录为基准解析，注册表可整体搬移。 */
export function loadRoleRegistry(file: string): RoleRegistry | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as RoleRegistry;
    if (!raw || typeof raw !== "object" || !raw.roles) return null;
    const base = path.dirname(path.resolve(file));
    const skillsRoot = raw.skillsRoot
      ? (path.isAbsolute(raw.skillsRoot) ? raw.skillsRoot : path.resolve(base, raw.skillsRoot))
      : path.resolve(base, "skills");
    return { skillsRoot, roles: raw.roles, routes: raw.routes ?? {} };
  } catch (e) {
    console.warn("[role-registry] 读取失败, 本次不注入角色能力:", e);
    return null;
  }
}

/** 按会话 id 解析角色（routes 精确命中 → default；default 也未配置则给空能力） */
export function resolveRole(
  reg: RoleRegistry,
  chatId: string,
): { id: string; config: RoleCapabilityConfig } {
  const id = reg.routes[chatId] ?? "default";
  const roleId = reg.roles[id] ? id : "default";
  return { id: roleId, config: reg.roles[roleId] ?? { skills: [], mcpServers: [] } };
}

/** 极简 YAML 生成（只覆盖本注册表的形状: 对象/字符串数组/字符串记录） */
function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    return v.map((item) => {
      if (typeof item !== "object" || item === null) return `${pad}- ${JSON.stringify(item)}`;
      const body = toYaml(item, indent + 2);
      return `${pad}-\n${body}`;
    }).join("\n");
  }
  if (typeof v === "object" && v !== null) {
    return Object.entries(v)
      .filter(([, val]) => val !== undefined)
      .map(([k, val]) => {
        if (typeof val === "object" && val !== null && (Array.isArray(val) ? val.length : true)) {
          return `${pad}${k}:\n${toYaml(val, indent + 1)}`;
        }
        return `${pad}${k}: ${typeof val === "string" ? JSON.stringify(val) : String(val)}`;
      })
      .join("\n");
  }
  return `${pad}${typeof v === "string" ? JSON.stringify(v) : String(v)}`;
}

/**
 * 生成角色 patch overlay 文件（--patch 传给官方 CLI，与用户补丁层叠加）：
 *   - 有 skills: 覆盖官方 skill-filesystem 行的 customSkillDirs
 *   - 每个 mcpServer: insert 一个 @deepseek-ai/dsh-mcp-client 实例
 * 无任何能力时不产出文件（返回 null，零开销）。
 */
export function buildRolePatchFile(
  reg: RoleRegistry,
  role: { id: string; config: RoleCapabilityConfig },
  outFile: string,
): string | null {
  const entries: Array<Record<string, unknown>> = [];
  const skillDirs = (role.config.skills ?? [])
    .map((name) => (path.isAbsolute(name) ? name : path.resolve(reg.skillsRoot, name)))
    .filter((dir) => existsSync(dir));
  if (skillDirs.length > 0) {
    entries.push({ id: "skill-filesystem", config: { customSkillDirs: skillDirs } });
  }
  const servers = role.config.mcpServers ?? [];
  if (servers.length > 0) {
    entries.push({
      insert: servers.map((s) => ({
        id: `mcp-${s.serverName}`,
        name: "@deepseek-ai/dsh-mcp-client",
        config: s.url
          ? {
              transport: "streamable-http",
              serverName: s.serverName,
              url: s.url,
              ...(s.headers ? { headers: s.headers } : {}),
              ...(s.failOnStartupError !== undefined ? { failOnStartupError: s.failOnStartupError } : {}),
            }
          : {
              transport: "stdio",
              serverName: s.serverName,
              command: s.command,
              ...(s.args ? { args: s.args } : {}),
              ...(s.env ? { env: s.env } : {}),
              ...(s.cwd ? { cwd: s.cwd } : {}),
              ...(s.failOnStartupError !== undefined ? { failOnStartupError: s.failOnStartupError } : {}),
            },
      })),
    });
  }
  if (entries.length === 0) return null;
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `# generated for role "${role.id}" by dsh-interop session-relay\n${toYaml(entries)}\n`, "utf8");
  return outFile;
}

// ── dsh CLI 子进程 ────────────────────────────────────────────────

export interface DshRunOptions {
  /** dsh CLI 的 bin.js 绝对路径；缺省从 @deepseek-ai/dsh 包自动探测 */
  dshBinJs?: string;
  /** DSH 家目录（注入 DSH_HOME；sessions/profiles/凭据都在这下面） */
  dshHome: string;
  /** agent 工作目录（决定会话归属的工作区 key） */
  cwd: string;
  /** 用户消息文本（多轮上下文由调用方拼进此文本） */
  task: string;
  /** 注入子进程的额外环境变量（DEEPSEEK_API_KEY / DSH_PERMISSION_MODE 等） */
  extraEnv?: Record<string, string>;
  /** 追加的 patch overlay 文件（--patch 可重复，与用户补丁层叠加） */
  patchFiles?: string[];
  /** 整体超时（默认 900s = 15 分钟，可用 DSH_RELAY_TIMEOUT_MS 覆盖：agent 干活可能较久） */
  timeoutMs?: number;
}

/** 默认 headless 超时：优先读环境变量 DSH_RELAY_TIMEOUT_MS（毫秒），缺省 15 分钟。 */
function resolveDefaultTimeoutMs(): number {
  const raw = process.env["DSH_RELAY_TIMEOUT_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900_000;
}

export interface DshRunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** 官方 CLI 的 bin.js 绝对路径（直接用 node 跑，跨平台无 .cmd shim 问题） */
export function resolveDshBinJs(): string {
  const pkgPath = localRequire.resolve("@deepseek-ai/dsh/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  const rel = pkg.bin?.dsh;
  if (!rel) throw new Error("@deepseek-ai/dsh 未声明 bin.dsh");
  return path.join(path.dirname(pkgPath), rel);
}

/** 运行一次 dsh headless（每次都是新会话；多轮靠调用方上下文注入）。 */
export function dshRunCli(opts: DshRunOptions): Promise<DshRunResult> {
  const started = Date.now();
  const binJs = opts.dshBinJs ?? resolveDshBinJs();
  const args = ["--profile", "headless"];
  for (const f of opts.patchFiles ?? []) args.push("--patch", f);
  args.push(opts.task);

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [binJs, ...args],
      {
        cwd: opts.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          DSH_HOME: opts.dshHome,
          ...(opts.extraEnv ?? {}),
        } as NodeJS.ProcessEnv,
      },
    );
    let out = "";
    let errText = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      opts.timeoutMs ?? resolveDefaultTimeoutMs(),
    );
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errText += d.toString("utf8"); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (code === 0) {
        resolve({ ok: true, output: out.trim(), durationMs });
      } else {
        const tail = (errText || out).trim().split(/\r?\n/).slice(-6).join("\n");
        resolve({ ok: false, output: out.trim(), error: tail || `exit ${code}`, durationMs });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: String(e), durationMs: Date.now() - started });
    });
  });
}

// ── 滚动对话历史 ──────────────────────────────────────────────────

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * 按 chatId 滚动对话历史（JSON 持久化，重启不丢）。
 * 上限：最多 MAX_TURNS 轮 / MAX_CONTEXT_CHARS 字符，超出丢最旧。
 */
export class TranscriptStore {
  private map = new Map<string, TranscriptTurn[]>();

  constructor(
    private readonly filePath: string,
    private readonly maxTurns = 12,
    private readonly maxContextChars = 6000,
  ) {
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, TranscriptTurn[]>;
        for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) this.map.set(k, v);
      }
    } catch (e) {
      console.warn("[transcript] 读取失败, 从空历史开始:", e);
    }
  }

  get(chatId: string): TranscriptTurn[] {
    return this.map.get(chatId) ?? [];
  }

  push(chatId: string, role: "user" | "assistant", text: string): void {
    const turns = this.get(chatId);
    turns.push({ role, text });
    while (
      turns.length > this.maxTurns ||
      turns.reduce((n, t) => n + t.text.length, 0) > this.maxContextChars
    ) {
      if (turns.length <= 1) break;
      turns.shift();
    }
    this.map.set(chatId, turns);
    this.flush();
  }

  clear(chatId: string): void {
    this.map.delete(chatId);
    this.flush();
  }

  private flush(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8");
  }
}

// ── 中继执行体 ────────────────────────────────────────────────────

/** IM 侧请求的最小契约（与角色一致: {user_input, user_id} → {response}） */
export interface RelayRequest {
  user_input: string;
  user_id?: string;
}

export interface DshSessionRelayOptions {
  /** DSH 家目录（注入 DSH_HOME） */
  dshHome: string;
  /** agent 工作目录，缺省 process.cwd() */
  cwd?: string;
  /** 历史落盘文件（JSON） */
  transcriptFile: string;
  /** dsh bin.js；缺省自动探测 */
  dshBinJs?: string;
  /** 注入子进程的额外环境变量 */
  extraEnv?: Record<string, string>;
  /** 回复长度上限（超出保留首尾），默认 3500 */
  maxReply?: number;
  /** 角色能力注册表文件（roles.json）；设置后每条消息按会话解析角色并注入 skill/MCP */
  roleRegistryFile?: string;
  /** 角色 patch overlay 的输出目录（缺省与 transcriptFile 同目录） */
  patchDir?: string;
  /** headless 整体超时 ms，默认 900s（15 分钟，可用 DSH_RELAY_TIMEOUT_MS 覆盖） */
  timeoutMs?: number;
}

/** 中继支持的聊天内指令 */
export const RELAY_COMMANDS = ["/new", "/session"] as const;

/**
 * 创建中继执行体：返回 (request) → Result<{response}>。
 * /new 清空历史、/session 查看轮数；普通消息按滚动上下文转发 headless。
 */
export function createDshSessionRelayExecute(
  opts: DshSessionRelayOptions,
): (request: RelayRequest, ctx?: SeamContext) => Promise<Result<{ response: string }>> {
  const dshBinJs = opts.dshBinJs ?? resolveDshBinJs();
  const cwd = opts.cwd ?? process.cwd();
  const transcript = new TranscriptStore(opts.transcriptFile);
  const maxReply = opts.maxReply ?? 3500;

  return async (request: RelayRequest): Promise<Result<{ response: string }>> => {
    const text = request.user_input.trim();
    const chatId = request.user_id ?? "default";

    if (text === "/new") {
      transcript.clear(chatId);
      return ok({ response: "✅ 已清空当前聊天的对话历史，下条消息从零开始。" });
    }
    if (text === "/session") {
      const turns = transcript.get(chatId).length;
      return ok({ response: turns > 0 ? `当前保留 ${turns} 轮对话上下文。` : "尚无对话历史。" });
    }

    const history = transcript.get(chatId);
    const contextBlock = history.length
      ? history.map((t) => `${t.role === "user" ? "用户" : "助手"}: ${t.text}`).join("\n") + "\n\n"
      : "";
    console.log(`[relay] chat=${chatId} history=${history.length}轮 task=${text.slice(0, 60)}…`);

    // 角色能力注入：注册表每条消息重新读取（改完即热生效）
    let patchFiles: string[] | undefined;
    if (opts.roleRegistryFile) {
      const reg = loadRoleRegistry(opts.roleRegistryFile);
      if (reg) {
        const role = resolveRole(reg, chatId);
        const patchDir = opts.patchDir ?? path.dirname(opts.transcriptFile);
        const patch = buildRolePatchFile(reg, role, path.join(patchDir, `patch-${role.id}.yml`));
        patchFiles = patch ? [patch] : undefined;
        console.log(
          `[relay] role=${role.id} skills=${role.config.skills?.length ?? 0} mcp=${role.config.mcpServers?.length ?? 0} patch=${patch ? "on" : "off"}`,
        );
      }
    }

    const result = await dshRunCli({
      dshBinJs,
      dshHome: opts.dshHome,
      cwd,
      task: contextBlock ? `以下是此前的对话记录（供参考上下文）:\n${contextBlock}请回答本次消息: ${text}` : text,
      extraEnv: opts.extraEnv,
      patchFiles,
      timeoutMs: opts.timeoutMs,
    });

    if (!result.ok) {
      return ok({
        response: `⚠️ agent 执行失败 (${(result.durationMs / 1000).toFixed(0)}s):\n${result.error ?? "未知错误"}`,
      });
    }

    transcript.push(chatId, "user", text);

    let response = result.output || "(agent 无文本输出)";
    transcript.push(chatId, "assistant", response);
    if (response.length > maxReply) {
      response = response.slice(0, 800) + "\n\n…(中间略)…\n\n" + response.slice(-maxReply + 800);
    }
    return ok({ response });
  };
}

// ── 服务定义 + Provider 工厂 ──────────────────────────────────────

export const dshSessionRelayRef: CapabilityRef = {
  id: "@infrastructure/dsh-session-relay",
  versionRange: "^1.0.0",
};

export const dshSessionRelayService: ServiceDefinition<RelayRequest, { response: string }> = {
  id: "@infrastructure/dsh-session-relay",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "IM 消息 → 官方 dsh headless agent 会话中继（滚动上下文多轮）",
};

/**
 * 装配中继 Provider（IM 装配层注册到 kernel 即可；
 * dshHome/cwd 等从环境变量取，由装配方传入）。
 */
export function createDshSessionRelayProvider(
  opts: DshSessionRelayOptions,
): Provider<RelayRequest, { response: string }> {
  const execute = createDshSessionRelayExecute(opts);
  const configured = Boolean(opts.dshHome);
  return {
    service: dshSessionRelayService,
    name: "infrastructure-dsh-session-relay",
    state: PluginState.Active,
    async health(): Promise<HealthStatus> {
      return {
        healthy: configured,
        detail: configured ? `dshHome=${opts.dshHome}` : "DSH_HOME 未配置",
        checkedAt: new Date().toISOString(),
      };
    },
    execute(request, ctx): Promise<Result<{ response: string }>> {
      if (!configured) {
        return Promise.resolve(err("缺少配置: DSH_HOME（dsh headless 的家目录）"));
      }
      return execute(request, ctx);
    },
  };
}

// ── .env 加载（收敛自各 example 的 env.ts 拷贝） ─────────────────

/**
 * 极简 .env 加载器：先到先得（不覆盖已有环境变量）。
 * 装配方可按优先级多次调用（例：先 example 私有 .env，再仓库根 .env）。
 */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) {
    console.warn(`[env] .env 不存在 (${file}), 依赖环境变量`);
    return;
  }
  const lines = readFileSync(file, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
