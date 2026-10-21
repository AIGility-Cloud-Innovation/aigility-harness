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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** 角色专属指令源（persona 三级 M-A，2026-10-08）：SKILL.md/AGENTS.md 全文，
   *  存在时以 agent-instructions patch 覆盖注入（candidates 收窄为该文件）。
   *  相对路径以 skillsRoot 为基准。缺省 = 按角色包自动解析（见角色包 SKILL.md 约定），
   *  再缺省才用官方缺省候选。 */
  instructionsFile?: string;
}

/** 角色能力注册表文件结构（每条消息重新读取：改完即热生效） */
export interface RoleRegistry {
  /** 技能根目录（roles.*.skills 的相对基准） */
  skillsRoot: string;
  /** 角色包目录列表（persona 三级 M-A）：按优先级排列，同 id 站点优先。
   *  相对路径以注册表文件所在目录为基准；缺省 = 注册表旁的 roles/ 与 data/roles/。 */
  rolesDirs?: string[];
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
    // 角色包目录（M-A）：相对路径以注册表文件所在目录为基准（与 skillsRoot 同规则）
    const rolesDirs = raw.rolesDirs
      ?.filter((d) => typeof d === "string" && d.trim())
      .map((d) => (path.isAbsolute(d) ? d : path.resolve(base, d)));
    return { skillsRoot, rolesDirs, roles: raw.roles, routes: raw.routes ?? {} };
  } catch (e) {
    console.warn("[role-registry] 读取失败, 本次不注入角色能力:", e);
    return null;
  }
}

/** 解析角色包目录候选（M-A）：显式 rolesDirs > 注册表旁 roles/ 与站点 data/roles/ */
function resolveRolesDirs(reg: RoleRegistry): string[] {
  if (reg.rolesDirs?.length) return reg.rolesDirs.filter((d) => existsSync(d));
  const base = path.dirname(path.resolve(reg.skillsRoot));
  return [path.resolve(base, "../data/roles"), path.resolve(base, "roles")].filter((d) => existsSync(d));
}

/**
 * 角色包 SKILL.md 正文解析（M-A）：SKILL.md 是人设唯一事实源。
 * 返回剥除 frontmatter 后的正文（空/缺失返回 null）。
 */
function readRoleSkillBody(roleId: string, reg: RoleRegistry): { file: string; body: string } | null {
  for (const dir of resolveRolesDirs(reg)) {
    const file = path.join(dir, roleId, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const md = readFileSync(file, "utf8");
      const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
      const body = (m ? md.slice(m[0].length) : md).trim();
      if (body) return { file, body };
    } catch {
      // 单个角色包损坏不拖垮会话
    }
  }
  return null;
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
  /** 会话工作目录：AGENTS 快照落盘处（DSH 在该目录下按文件名扫描候选）。
   *  缺省回落到 patch 文件所在目录（向后兼容旧调用方/单测）。 */
  cwd?: string,
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
              ...(s.cwd ? { cwd: s.cwd } : {}),
              ...(s.env ? { env: s.env } : {}),
              ...(s.failOnStartupError !== undefined ? { failOnStartupError: s.failOnStartupError } : {}),
            },
      })),
    });
  }
  // M-A（2026-10-08）角色专属指令注入：SKILL.md 是人设唯一事实源。
  // 解析优先级：显式 instructionsFile（逃生舱）> 角色包 <rolesDir>/<role.id>/SKILL.md。
  // patch 覆盖 agent-instructions 候选表收窄为该文件——DSH 实测：覆盖后 baseline
  // identity 的 candidates 收窄、注入字节数即为生效硬证据。
  // 快照复制到 patch 目录（与会话同生命周期，避免源文件后续变动影响本次会话）。
  const explicitFile = role.config.instructionsFile
    ? path.isAbsolute(role.config.instructionsFile)
      ? role.config.instructionsFile
      : path.resolve(reg.skillsRoot, role.config.instructionsFile)
    : undefined;
  // 角色包解析：SKILL.md 全文即引擎级 AGENTS.md 正文来源（§1 单文本投递）
  const pkg = !explicitFile && role.id !== "default" ? readRoleSkillBody(role.id, reg) : null;
  const personaFile = explicitFile && existsSync(explicitFile) ? explicitFile : pkg?.file;
  // 无显式配置、且角色包无有效人设（正文为空/缺失）→ 不产出该分支（零开销）
  const personaText = explicitFile && existsSync(explicitFile)
    ? undefined
    : pkg?.body;
  if (personaFile) {
    // 落盘位置按 DSH 扫描语义：候选文件名必须在「会话 cwd 或它的祖先目录」下。
    // 缺省 cwd 回落到 patch 目录（旧行为，仅供单测/无 cwd 场景）。
    const snapshotDir = cwd ?? path.dirname(outFile);
    mkdirSync(snapshotDir, { recursive: true });
    const agentsCopy = path.join(snapshotDir, `AGENTS-${role.id}.md`);
    // 角色包路径：只写正文快照（原文已剥 frontmatter，避免 YAML 元数据污染 system prompt）
    if (personaText !== undefined) writeFileSync(agentsCopy, `${personaText}\n`, "utf8");
    else copyFileSync(personaFile, agentsCopy);
    // ⚠️ DSH 语义（实测 2026-10-08）：instructionFileCandidates 是「在每个祖先目录下
    // 依次查找的相对文件名」，不能含路径分隔符——dsh-agent-instructions 的
    // resolveInstructionFileCandidates() 会静默丢弃含 [\\/] 的候选（不报错、不告警）。
    // 因此这里只传文件名，由调用方把快照落到会话 cwd（见 roleDirs → cwd 投递约定）。
    entries.push({
      id: "agent-instructions",
      config: {
        instructionFileCandidates: [`AGENTS-${role.id}.md`],
        maxBytes: 65536,
      },
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
  /** 单轮最长无输出容忍时间（毫秒），即「真空闲」阈值；有任何一个 chunk 到达就重新计时。默认 300s，可用 DSH_RELAY_TIMEOUT_MS 覆盖 */
  timeoutMs?: number;
}

/**
 * 默认 idle 阈值：优先读环境变量 DSH_RELAY_TIMEOUT_MS（毫秒），缺省 5 分钟。
 *
 * 语义是「多久没有任何输出」而不是「一轮最长跑多久」——只要模型/工具还在产出，
 * 计时器就不断被刷新，跑多久都不会被杀；只有真正卡死才会命中。
 * 变量名沿用 DSH_RELAY_TIMEOUT_MS 以保持向后兼容，但它的含义已从总时长改为空闲阈值。
 */
function resolveDefaultIdleMs(): number {
  const raw = process.env["DSH_RELAY_TIMEOUT_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

export interface DshRunResult {
  ok: boolean;
  output: string;
  error?: string;
  durationMs: number;
  /**
   * 因 idle 超时被 SIGKILL 终止（长时间无任何 stdout/stderr 输出）。
   * 此时 output 保留终止前已产出的部分内容，调用方可选择降级使用。
   * 注意：这不是「一轮跑太久」，而是「中途卡死」——正常运行多久都不会命中。
   */
  timedOut?: boolean;
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
    let timedOut = false;

    // ── idle watchdog（取代「总时长硬杀」）─────────────────────────────
    // 只要子进程还有任何 stdout/stderr 产出，就说明它活着，计时器不断重置；
    // 只有当连续 idleMs 内一个字节都没有时，才判定为真卡死并 SIGKILL。
    // 这样「一轮跑 40 分钟」不再被杀，「一次网络挂死 5 分钟」照样被收割。
    const idleMs = opts.timeoutMs ?? resolveDefaultIdleMs();
    let idleTimer: NodeJS.Timeout | undefined;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const bumpIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        timedOut = true;
        console.warn(
          `[relay] idle ${Math.round(idleMs / 1000)}s 无任何输出，判定卡死，SIGKILL（已产出 ${out.length} 字符将被保留）`,
        );
        child.kill("SIGKILL");
      }, idleMs);
      // 不阻塞事件循环退出（watchdog 只是保险丝，不该让进程悬着）
      idleTimer.unref?.();
    };
    bumpIdle();

    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); bumpIdle(); });
    child.stderr.on("data", (d: Buffer) => { errText += d.toString("utf8"); bumpIdle(); });
    child.on("close", (code) => {
      clearIdle();
      const durationMs = Date.now() - started;
      if (code === 0) {
        resolve({ ok: true, output: out.trim(), durationMs });
      } else {
        const tail = (errText || out).trim().split(/\r?\n/).slice(-6).join("\n");
        resolve({ ok: false, output: out.trim(), error: tail || `exit ${code}`, durationMs, timedOut });
      }
    });
    child.on("error", (e) => {
      clearIdle();
      resolve({ ok: false, output: "", error: String(e), durationMs: Date.now() - started, timedOut });
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
  /** headless 单轮最长无输出时间（idle 阈值）ms，默认 300s（5 分钟），可用 DSH_RELAY_TIMEOUT_MS 覆盖 */
  timeoutMs?: number;
}

/** 中继支持的聊天内指令 */
export const RELAY_COMMANDS = ["/new", "/session", "/help"] as const;

/**
 * 创建中继执行体：返回 (request) → Result<{response}>。
 * /new 清空历史、/session 查看轮数、/help 列指令；普通消息按滚动上下文
 * 转发 headless。指令识别先归一化（全角／→半角、压空白）再匹配；首 token
 * 命令形（/^\/[a-z][\w-]*$/i）但不在清单内 → 回提示不再漏进模型；含第二
 * 个 / 的内容（如粘贴文件路径）按普通消息处理，保留直问能力。
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

    // 指令识别（2026-10-21 加固）：归一化后匹配，未知命令回提示不进模型
    const norm = text.replace(/／/g, "/").replace(/\s+/g, " ").trim();
    const firstToken = norm.split(" ")[0] ?? "";
    if (/^\/[a-zA-Z][a-zA-Z0-9_-]*$/.test(firstToken)) {
      if (firstToken === "/new") {
        transcript.clear(chatId);
        return ok({ response: "✅ 已清空当前聊天的对话历史，下条消息从零开始。" });
      }
      if (firstToken === "/session") {
        const turns = transcript.get(chatId).length;
        return ok({ response: turns > 0 ? `当前保留 ${turns} 轮对话上下文。` : "尚无对话历史。" });
      }
      return ok({
        response:
          firstToken === "/help" || firstToken === "/?"
            ? `可用指令：/new 清空对话历史 · /session 查看保留轮数 · /help 显示本帮助。其余消息直接对话。`
            : `❓ 未知指令「${firstToken}」。可用指令：${RELAY_COMMANDS.join("、")}。其余消息直接对话，无需以 / 开头。`,
      });
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
        // cwd 必传：AGENTS-<id>.md 快照要落到会话 cwd，DSH 才能按文件名扫到（见 M-A 注释）
        const patch = buildRolePatchFile(reg, role, path.join(patchDir, `patch-${role.id}.yml`), cwd);
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
      // idle 超时被杀的这一路：不丢产出。把已产出的部分正文交给用户，并明确标注未完成。
      // 注意：此路不计入 transcript（半截产出不得污染后续轮次的滚动上下文）。
      if (result.timedOut && result.output) {
        console.log(
          `[relay] chat=${chatId} idle 超时中断，保留部分产出 ${result.output.length} 字符（不入 transcript）`,
        );
        let partial = result.output;
        if (partial.length > maxReply) {
          partial = partial.slice(0, 800) + "\n\n…(中间略)…\n\n" + partial.slice(-maxReply + 800);
        }
        return ok({
          response: `${partial}\n\n---\n⚠️ 本轮未完成（idle ${(result.durationMs / 1000).toFixed(0)}s 内无输出，判定卡死已中断）。以上为中断前已产出的内容，仅供参考；本条未计入对话上下文。`,
        });
      }
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
