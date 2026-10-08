/**
 * M-D 轮 2：解析 DSH 会话事件流，提取「角色指令注入」事实。
 *
 * 背景：M-A 把角色人设写成 AGENTS-<roleId>.md 投递给 DSH，但注入是**静默**的——
 * 候选路径格式写错、文件没落到 cwd、超 maxBytes 被截断，全都无日志无报错。
 * 本模块把「到底注入了什么」变成可查询的事实，供 API/UI 面板消费。
 *
 * 数据源：<DSH_HOME>/sessions/<cwd转义>/<session-uuid>/session.v4.jsonl.zstd
 * 事件形态（实测 2026-10-08，DSH 0.2.0-rc.2）：
 *   { "type": "user/message", "seq": 9, "time": 1791471603534,
 *     "data": { "content": [{ "type": "text", "text": "<system-reminder>…" }],
 *               "source": { "kind": "agent-instructions", "form": "instructions",
 *                           "baseline": true,
 *                           "changes": [{ "action": "set",
 *                                         "scope": ".\u0000AGENTS-sales-chat.md",
 *                                         "path": "AGENTS-sales-chat.md",
 *                                         "digest": "a5b332…" }] },
 *               "role": "user" } }
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * 本项目 @types/node 停在 20.x，而运行时是 Node 22（zstd API 自 v22.15 起为官方 API）。
 * 类型定义滞后于运行时：静态 `import ... from "node:zlib"` 会被 tsc 拒绝（TS2305）。
 * 这里用 createRequire 动态取，绕开静态类型解析，避免为单个 API 升级整个 monorepo 的 @types/node。
 * 若将来 @types/node 升到 22+，可换回普通 import。
 */
const nodeRequire = createRequire(import.meta.url);
const zstdDecompressSync = (
  nodeRequire("node:zlib") as { zstdDecompressSync: (buf: Buffer) => Buffer }
).zstdDecompressSync;

/**
 * 解压 DSH 会话文件（**多帧** zstd）。
 *
 * ⚠️ 关键陷阱（实测 2026-10-08）：DSH 每写一批事件就追加一个 zstd 帧，
 * 一个会话文件通常有多个帧（实测 8 帧）。`zstdDecompressSync` 默认
 * **只解第一帧**——单帧文件看不出问题，多帧文件会**静默丢内容**
 * （实测 8 帧文件只解出 215/33265 字节，注入事件全部丢失，
 *  且与「注入确实失败」的现象无法区分）。
 *
 * 解法：按 zstd magic number 把流切成帧，逐帧解压后拼接。
 */
export function decompressSessionFile(file: string): string {
  const raw = readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (raw[offset] !== MAGIC[0] || raw.subarray(offset, offset + 4).compare(MAGIC) !== 0) {
      // 非帧头（异常位置）：放弃逐帧，整体兜底解压
      return zstdDecompressSync(raw).toString("utf8");
    }
    const next = raw.indexOf(MAGIC, offset + 4);
    const end = next === -1 ? raw.length : next;
    chunks.push(zstdDecompressSync(raw.subarray(offset, end)));
    offset = end;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 一次指令注入变更（DSH source.changes 元素） */
export interface InstructionChange {
  action: string;
  /** 相对候选文件名，如 AGENTS-sales-chat.md */
  path: string;
  /** 内容摘要（变更前后比对用） */
  digest: string;
}

/** 一条「指令注入」事件（会话里的一次 agent-instructions 注入） */
export interface InstructionInjectionEvent {
  seq: number;
  /** 事件时间（毫秒） */
  time: number;
  /** 注入形态：instructions=工作区指令 */
  form: string;
  /** 是否为基线注入（会话首轮） */
  baseline: boolean;
  changes: InstructionChange[];
  /** 注入正文（从 content 的 system-reminder 包裹里剥出） */
  text: string;
  /** 正文字节数（DSH 按 maxBytes 截断，可用于判断是否被截） */
  bytes: number;
}

/** 会话注入概览 */
export interface InstructionSummary {
  /** 会话事件文件路径（解压前的 .zstd） */
  file: string;
  /** 会话 total 事件数（含非注入事件） */
  totalEvents: number;
  /** 注入事件列表（按 seq 升序） */
  injections: InstructionInjectionEvent[];
  /** 去重后的候选文件名（即「本会话被投递过哪些指令文件」） */
  candidateFiles: string[];
}

/**
 * 把 cwd 路径转成 DSH 的 sessions 子目录名。
 * 规则（实测 2026-10-08）：去掉首尾分隔符，内部分隔符全换成 `-`，两端补 `--`。
 *   /home/johnny/ws → --home-johnny-ws--
 * 注意：该转换是 DSH 内部实现，这里按实测规则复刻并在单测里锁定。
 */
export function cwdToSessionDirName(cwd: string): string {
  // 先剥掉首尾分隔符（否则开头的 / 会被替换成多余的 -）
  const trimmed = cwd.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
  return `--${trimmed.replace(/[/\\]/g, "-")}--`;
}

/** 定位某 cwd 下最新的会话事件文件（无会话时返回 null） */
export function findLatestSessionFile(dshHome: string, cwd: string): string | null {
  const dir = join(dshHome, "sessions", cwdToSessionDirName(cwd));
  if (!existsSync(dir)) return null;
  const sessions = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  if (sessions.length === 0) return null;
  const withFile = sessions
    .map((s) => ({ s, f: join(s, "session.v4.jsonl.zstd"), mtime: statSync(s).mtimeMs }))
    .filter((x) => existsSync(x.f))
    // mtime 相同时（同毫秒创建）用目录名兜底，保证结果确定
    .sort((a, b) => b.mtime - a.mtime || b.s.localeCompare(a.s));
  return withFile.length ? withFile[0].f : null;
}

/** 剥掉 DSH 的 <system-reminder> 包裹，只留指令正文 */
function stripReminder(text: string): string {
  const m = text.match(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/);
  if (!m) return text;
  // 去掉开头的「The following workspace instructions…」说明段与 "Instructions from: X" 行
  return m[1]
    .replace(/^The following workspace instructions[\s\S]*?\n\n/, "")
    .replace(/^Instructions from: [^\n]*\n\n?/, "")
    .trim();
}

/**
 * 解析已解压的 NDJSON 文本。
 * 容错：坏行跳过（会话文件可能被并发追加写坏尾行），不整体失败。
 */
export function parseInstructionEvents(ndjson: string): InstructionInjectionEvent[] {
  const out: InstructionInjectionEvent[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // 坏行：跳过
    }
    const source = ev?.data?.source;
    if (source?.kind !== "agent-instructions") continue;
    const blocks = ev?.data?.content;
    const text = Array.isArray(blocks)
      ? blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n")
      : "";
    const changes: InstructionChange[] = Array.isArray(source.changes)
      ? source.changes.map((c: any) => ({
          action: String(c?.action ?? ""),
          path: String(c?.path ?? ""),
          digest: String(c?.digest ?? ""),
        }))
      : [];
    out.push({
      seq: Number(ev?.seq ?? 0),
      time: Number(ev?.time ?? 0),
      form: String(source.form ?? ""),
      baseline: Boolean(source.baseline),
      changes,
      text: stripReminder(text),
      bytes: Buffer.byteLength(stripReminder(text), "utf8"),
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** 读会话文件并汇总注入事实（文件不存在→空概览，不抛错） */
export function summarizeInstructions(sessionFile: string | null): InstructionSummary {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { file: "", totalEvents: 0, injections: [], candidateFiles: [] };
  }
  const ndjson = decompressSessionFile(sessionFile);
  const totalEvents = ndjson.split("\n").filter((l) => l.trim()).length;
  const injections = parseInstructionEvents(ndjson);
  const candidateFiles = [...new Set(injections.flatMap((i) => i.changes.map((c) => c.path)))];
  return { file: sessionFile, totalEvents, injections, candidateFiles };
}

/** 一步到位：给定 dshHome + cwd，返回最近一次会话的注入概览 */
export function summarizeLatestInstructions(dshHome: string, cwd: string): InstructionSummary {
  return summarizeInstructions(findLatestSessionFile(dshHome, cwd));
}