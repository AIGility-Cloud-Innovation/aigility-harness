/**
 * L4 编排层: requirement-store — 需求缓冲区存储
 *
 * 设计见 docs/task-orchestration-workflow-design.md 扩展章节 E3。
 * 会话级小数据(一个会话的需求清单 + 汇总单), 不值得为此把 PG 依赖
 * 引进编排层插件 → 内存 Map + JSON 文件落盘, 启动时恢复。
 *
 * CAS 语义: transition 只在当前 status 匹配期望值时才流转,
 * 并发/重复转移返回 err(借鉴 timem-project 的 UPDATE ... WHERE state=?)。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { err, ok } from "@aigility-harness/core";
import type { Result } from "@aigility-harness/core";

// ---- 会话阶段 (E2 状态机在存储侧的投影) ----

export type SessionPhase = "collecting" | "summarizing" | "confirming" | "executing";

export interface SessionState {
  sessionId: string;
  phase: SessionPhase;
  /** 静默计时锚点: 最后一条需求入清单的时间(恢复 quiet window 用) */
  lastRequirementAt: number;
  /** 汇总后用户又补充了需求 → 需重新汇总 */
  hasNewSinceConsolidation: boolean;
}

// ---- 需求条目 (E3) ----

export type RequirementStatus = "open" | "merged" | "dropped" | "tasked";

export interface Requirement {
  id: string;
  sessionId: string;
  /** AI 抽取的一句话摘要 */
  content: string;
  /** 原文引用(溯源) */
  rawMessage: string;
  createdAt: number;
  status: RequirementStatus;
  /** 去重后指向合并目标 req id */
  mergedInto?: string;
}

// ---- 汇总单 (E3/E4) ----

export interface ConsolidationItem {
  /** 该任务由哪几条原始需求合并而成(下标) */
  requirementIds: string[];
  taskTitle: string;
  taskDescription: string;
  mergedReason?: string;
  /** 依赖哪些 item(下标), 构成 DAG */
  dependsOn: number[];
  blockedByConflict?: string;
  missingInformation?: string[];
  acceptanceCriteria: string[];
}

export interface Consolidation {
  id: string;
  sessionId: string;
  version: number;
  items: ConsolidationItem[];
  /** 统一设计方案(markdown, 注入每个任务的上下文) */
  designDoc: string;
  createdAt: number;
  /** 拓扑排序后的执行顺序(items 下标), 环检测失败回退 LLM 原序 */
  executionOrder: number[];
  orderIsFallback: boolean;
}

// ---- 合法状态转移表 (open→merged/dropped/tasked 是单向的) ----

const REQUIREMENT_TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  open: ["merged", "dropped", "tasked"],
  merged: [],
  dropped: ["open"], // 用户可在确认页推翻"无效"判定
  tasked: [],
};

// ---- 存储 ----

export class RequirementStore {
  private requirements = new Map<string, Requirement>();
  private consolidations = new Map<string, Consolidation>();
  private sessions = new Map<string, SessionState>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly filePath?: string) {}

  // -- 会话 --

  /** 取会话状态, 不存在则初始化为 collecting */
  session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        phase: "collecting",
        lastRequirementAt: 0,
        hasNewSinceConsolidation: false,
      };
      this.sessions.set(sessionId, s);
      this.markDirty();
    }
    return s;
  }

  setPhase(sessionId: string, phase: SessionPhase): void {
    const s = this.session(sessionId);
    s.phase = phase;
    this.markDirty();
  }

  // -- 需求条目 --

  append(sessionId: string, content: string, rawMessage: string): Requirement {
    const req: Requirement = {
      id: `req_${randomUUID().slice(0, 8)}`,
      sessionId,
      content,
      rawMessage,
      createdAt: Date.now(),
      status: "open",
    };
    this.requirements.set(req.id, req);
    const s = this.session(sessionId);
    s.lastRequirementAt = req.createdAt;
    s.hasNewSinceConsolidation = true;
    this.markDirty();
    return req;
  }

  listOpen(sessionId: string): Requirement[] {
    return [...this.requirements.values()]
      .filter((r) => r.sessionId === sessionId && r.status === "open")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Requirement | undefined {
    return this.requirements.get(id);
  }

  listAll(sessionId: string): Requirement[] {
    return [...this.requirements.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** CAS 转移: 仅当当前 status 等于 from 时流转到 to */
  transition(
    reqId: string,
    from: RequirementStatus,
    to: RequirementStatus,
    extra?: { mergedInto?: string },
  ): Result<Requirement> {
    const req = this.requirements.get(reqId);
    if (!req) return err(`requirement ${reqId} not found`);
    if (req.status !== from) {
      return err(`CAS failed: ${reqId} is ${req.status}, expected ${from}`);
    }
    if (!REQUIREMENT_TRANSITIONS[from]?.includes(to)) {
      return err(`illegal transition ${from} → ${to}`);
    }
    req.status = to;
    if (extra?.mergedInto) req.mergedInto = extra.mergedInto;
    this.markDirty();
    return ok(req);
  }

  // -- 汇总单 --

  saveConsolidation(c: Consolidation): void {
    this.consolidations.set(c.id, c);
    this.session(c.sessionId).hasNewSinceConsolidation = false;
    this.markDirty();
  }

  latestConsolidation(sessionId: string): Consolidation | undefined {
    let latest: Consolidation | undefined;
    for (const c of this.consolidations.values()) {
      if (c.sessionId !== sessionId) continue;
      if (!latest || c.version > latest.version) latest = c;
    }
    return latest;
  }

  // -- 持久化: 脏标记 + 1s 防抖落盘, 启动恢复 --

  private markDirty(): void {
    this.dirty = true;
    if (this.filePath && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushSync();
      }, 1000);
      // 不阻止进程退出
      (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  flushSync(): void {
    if (!this.filePath || !this.dirty) return;
    const dump = {
      requirements: [...this.requirements.values()],
      consolidations: [...this.consolidations.values()],
      sessions: [...this.sessions.values()],
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(dump, null, 2), "utf-8");
      this.dirty = false;
    } catch (e) {
      console.error(`[requirement-store] flush failed: ${String(e)}`);
    }
  }

  /** 启动/测试恢复。文件不存在视为空库, 返回恢复条数 */
  recover(): number {
    if (!this.filePath || !existsSync(this.filePath)) return 0;
    try {
      const dump = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
        requirements: Requirement[];
        consolidations: Consolidation[];
        sessions: SessionState[];
      };
      for (const r of dump.requirements ?? []) this.requirements.set(r.id, r);
      for (const c of dump.consolidations ?? []) this.consolidations.set(c.id, c);
      for (const s of dump.sessions ?? []) this.sessions.set(s.sessionId, s);
      this.dirty = false;
      const n = dump.requirements?.length ?? 0;
      if (n > 0) console.log(`[requirement-store] recovered ${n} requirements from ${this.filePath}`);
      return n;
    } catch (e) {
      console.error(`[requirement-store] recover failed (start empty): ${String(e)}`);
      return 0;
    }
  }
}
