/**
 * L4 编排层: task-registry — 统一任务登记表（TaskRecord 权威存储 + 多源关联）
 *
 * 对应契约 @aigility-harness/core/task-provider（UID 决策见该文件头）：
 * harness 自发号 uid，飞书任务/Gitea 工单/agentd 任务一律以 links 记录，
 * 正反查（uid ↔ 外部句柄）均走本表，替代历史上的标题正则缝合。
 *
 * 存储形态与 requirement-store 同款：内存 Map + JSON 落盘（1s 合并写），
 * 构造时可传文件路径；PG 版后续按 pg-task-queue 模式替换，契约不变。
 *
 * CAS 语义：transition 只在当前 status 匹配期望值（或未指定期望）且
 * 转移在 TASK_STATUS_TRANSITIONS 表内时才流转；重复/并发转移返回 err。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, TASK_STATUS_TRANSITIONS, newTaskUid } from "@aigility-harness/core";
import type { Result, TaskRecord, UnifiedStatus, ExternalHandle, CollectTaskInput } from "@aigility-harness/core";

/** 收编入参（uid/时间戳由本表生成）；与契约 CollectTaskInput 同形 */
export type AdoptTaskInput = CollectTaskInput;

export interface TaskListFilter {
  status?: UnifiedStatus[];
  projectRef?: string;
  /** 关联了某 provider 句柄的记录 */
  linkedProvider?: string;
}

export class TaskRegistry {
  private records = new Map<string, TaskRecord>();
  /** `${provider}|${guid}` → uid 反查索引 */
  private byExternal = new Map<string, string>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly filePath?: string) {}

  // -- 收编与查询 --

  /**
   * 收编一条外部任务。同一真实任务的多个源句柄收敛为一条记录：
   *   ① origin 命中既有记录 → 只补缺失句柄后返回；
   *   ② related 任一句柄命中（另一源已入册）→ 并入该记录；
   *   ③ 都未命中 → 发号新建，origin + related 全部挂为 links。
   * 先入册者的 title/projectRef/status 为准（首次收编生效），后到源只补句柄。
   * 这是 collect provider 与登记表的唯一入口。
   */
  adopt(input: AdoptTaskInput): TaskRecord {
    const mergeInto = (record: TaskRecord): TaskRecord => {
      let changed = false;
      const put = (provider: string, handle: ExternalHandle) => {
        if (!(provider in record.links)) {
          record.links[provider] = { ...handle };
          this.indexLinks(record);
          changed = true;
        }
      };
      put(input.origin.provider, { guid: input.origin.guid, ...(input.origin.url ? { url: input.origin.url } : {}) });
      for (const [provider, handle] of Object.entries(input.related ?? {})) put(provider, handle);
      if (changed) {
        record.updatedAt = Date.now();
        this.markDirty();
      }
      return record;
    };

    let existing = this.findByExternal(input.origin.provider, input.origin.guid);
    if (!existing) {
      for (const [provider, handle] of Object.entries(input.related ?? {})) {
        existing = this.findByExternal(provider, handle.guid);
        if (existing) break;
      }
    }
    if (existing) return mergeInto(existing);

    const now = Date.now();
    const record: TaskRecord = {
      uid: newTaskUid(),
      title: input.title,
      description: input.description,
      status: input.status ?? "planned",
      origin: { ...input.origin },
      projectRef: input.projectRef,
      links: {},
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.uid, record);
    return mergeInto(record);
  }

  // -- 人工/复核补齐 --

  /** 复核补齐：更新归属/描述/标题/结构化人员外键（自然语言复核入口落地用），幂等可重放 */
  update(
    uid: string,
    patch: { projectRef?: string; description?: string; title?: string; assignee_member_id?: string; reviewer_member_id?: string },
  ): Result<TaskRecord> {
    const record = this.records.get(uid);
    if (!record) return err(`task-registry: 未知任务 ${uid}`);
    if (patch.projectRef !== undefined) record.projectRef = patch.projectRef;
    if (patch.description !== undefined) record.description = patch.description;
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.assignee_member_id !== undefined) record.assignee_member_id = patch.assignee_member_id;
    if (patch.reviewer_member_id !== undefined) record.reviewer_member_id = patch.reviewer_member_id;
    record.updatedAt = Date.now();
    this.markDirty();
    return ok(record);
  }

  // -- 放行/复核（planned → ready 的唯一入口） --

  /**
   * 批准放行：planned → ready，写入复核记录（谁能看板展示"谁批的"）。
   * via="auto"  为五要素齐全自动放行（by 记 "system"）；
   * via="manual" 为人工批准（补齐确认/低置信一票/看板按钮），by=复核人。
   * CAS：仅 planned 态可放行；ready 态重复 approve 幂等返回既有记录。
   */
  approve(
    uid: string,
    opts: { by?: string; via?: "auto" | "manual"; note?: string; reviewer_member_id?: string } = {},
  ): Result<TaskRecord> {
    const via = opts.via ?? "manual";
    const by = opts.by ?? (via === "auto" ? "system" : "unknown");
    const record = this.records.get(uid);
    if (!record) return err(`task-registry: 未知任务 ${uid}`);
    if (record.status === "ready" && record.review) return ok(record); // 幂等重放
    const res = this.transition(uid, "ready", "planned");
    if (!res.ok) return res;
    const rec = res.value!;
    rec.review = {
      by,
      via,
      at: Date.now(),
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.reviewer_member_id ? { member_id: opts.reviewer_member_id } : {}),
    };
    if (opts.reviewer_member_id) rec.reviewer_member_id = opts.reviewer_member_id;
    rec.updatedAt = Date.now();
    this.markDirty();
    return ok(rec);
  }

  get(uid: string): TaskRecord | undefined {
    return this.records.get(uid);
  }

  findByExternal(provider: string, guid: string): TaskRecord | undefined {
    const uid = this.byExternal.get(externalKey(provider, guid));
    return uid ? this.records.get(uid) : undefined;
  }

  /** 挂载/更新实施侧句柄（agentd taskId、工单号回填等） */
  link(uid: string, provider: string, handle: ExternalHandle): Result<TaskRecord> {
    const record = this.records.get(uid);
    if (!record) return err(`task-registry: 未知任务 ${uid}`);
    record.links[provider] = { ...handle };
    this.indexLinks(record);
    record.updatedAt = Date.now();
    this.markDirty();
    return ok(record);
  }

  list(filter?: TaskListFilter): TaskRecord[] {
    return [...this.records.values()].filter((r) => {
      if (filter?.status && !filter.status.includes(r.status)) return false;
      if (filter?.projectRef && r.projectRef !== filter.projectRef) return false;
      if (filter?.linkedProvider && !(filter.linkedProvider in r.links)) return false;
      return true;
    });
  }

  // -- 状态机（CAS） --

  /**
   * 状态流转：expect 指定时作 CAS 校验（当前状态不符返回 err）；
   * 转移在 TASK_STATUS_TRANSITIONS[from] 表内才生效。
   * 转入 ready/planned/cancelled 时自动清除执行独占（允许重新派发）。
   */
  transition(uid: string, to: UnifiedStatus, expect?: UnifiedStatus): Result<TaskRecord> {
    const record = this.records.get(uid);
    if (!record) return err(`task-registry: 未知任务 ${uid}`);
    if (expect && record.status !== expect) {
      return err(`task-registry: ${uid} 状态 CAS 失败（当前 ${record.status}，期望 ${expect}）`);
    }
    if (record.status === to) return ok(record); // 幂等重放
    const allowed = TASK_STATUS_TRANSITIONS[record.status] ?? [];
    if (!allowed.includes(to)) {
      return err(`task-registry: ${uid} 非法转移 ${record.status} → ${to}（允许：${allowed.join("/") || "无"}）`);
    }
    record.status = to;
    if (to === "ready" || to === "planned" || to === "cancelled") delete record.assigned;
    record.updatedAt = Date.now();
    this.markDirty();
    return ok(record);
  }

  // -- 执行独占（收集全对齐，执行单 provider） --

  /**
   * 原子领取：ready → dispatched + 写入独占声明，一步完成。
   * 已被其它 provider 独占时拒绝（执行侧一个任务只交一个 provider）；
   * 同 provider 重复领取幂等（expect 传 "dispatched" 可重放）。
   */
  claim(uid: string, provider: string, handle: string, expect: UnifiedStatus = "ready"): Result<TaskRecord> {
    const record = this.records.get(uid);
    if (!record) return err(`task-registry: 未知任务 ${uid}`);
    if (record.assigned && record.assigned.provider !== provider) {
      return err(
        `task-registry: ${uid} 已由 ${record.assigned.provider} 独占执行（${record.assigned.handle}），拒绝改派 ${provider}`,
      );
    }
    const res = this.transition(uid, "dispatched", expect);
    if (!res.ok) return res;
    const rec = res.value!;
    rec.assigned = { provider, handle, at: Date.now() };
    rec.updatedAt = Date.now();
    this.markDirty();
    return ok(rec);
  }

  // -- 对齐原语（定期对齐器使用） --

  /**
   * 合并重复记录：absorb 的全部句柄并入 keep（缺失才补），absorb 删除。
   * 反查索引随句柄迁移指向 keep；keep===absorb 或记录缺失返回 err。
   */
  merge(keepUid: string, absorbUid: string): Result<TaskRecord> {
    if (keepUid === absorbUid) return err(`task-registry: 不能合并自身 ${keepUid}`);
    const keep = this.records.get(keepUid);
    const absorb = this.records.get(absorbUid);
    if (!keep || !absorb) return err(`task-registry: 合并目标缺失 keep=${keepUid} absorb=${absorbUid}`);
    for (const [provider, handle] of Object.entries(absorb.links)) {
      if (!(provider in keep.links)) keep.links[provider] = { ...handle };
    }
    this.records.delete(absorbUid);
    this.indexLinks(keep); // 句柄迁移后反查索引整体重指到 keep
    keep.updatedAt = Date.now();
    this.markDirty();
    return ok(keep);
  }

  /**
   * 不变量巡检：links 句柄与反查索引不一致（索引指向别的 uid，或索引缺失）。
   * 正常为空数组；非空说明发生过越权写入或历史脏数据，需人工/对齐器处理。
   */
  invariantViolations(): Array<{ kind: "divergence" | "missing"; uid: string; provider: string; guid: string; indexedTo?: string }> {
    const out: Array<{ kind: "divergence" | "missing"; uid: string; provider: string; guid: string; indexedTo?: string }> = [];
    for (const record of this.records.values()) {
      for (const [provider, handle] of Object.entries(record.links)) {
        const idx = this.byExternal.get(`${provider}|${handle.guid}`);
        if (idx === record.uid) continue;
        out.push(idx
          ? { kind: "divergence", uid: record.uid, provider, guid: handle.guid, indexedTo: idx }
          : { kind: "missing", uid: record.uid, provider, guid: handle.guid });
      }
    }
    return out;
  }

  // -- 持久化（requirement-store 同款：1s 合并写 + 显式恢复） --

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
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ tasks: [...this.records.values()] }, null, 2), "utf-8");
      this.dirty = false;
    } catch (e) {
      console.error(`[task-registry] flush failed: ${String(e)}`);
    }
  }

  /** 启动/测试恢复。文件不存在视为空库，返回恢复条数 */
  recover(): number {
    if (!this.filePath || !existsSync(this.filePath)) return 0;
    try {
      const dump = JSON.parse(readFileSync(this.filePath, "utf-8")) as { tasks?: TaskRecord[] };
      for (const t of dump.tasks ?? []) {
        this.records.set(t.uid, t);
        this.indexLinks(t);
      }
      return dump.tasks?.length ?? 0;
    } catch (e) {
      console.error(`[task-registry] recover failed: ${String(e)}`);
      return 0;
    }
  }

  private indexLinks(record: TaskRecord): void {
    for (const [provider, handle] of Object.entries(record.links)) {
      this.byExternal.set(externalKey(provider, handle.guid), record.uid);
    }
  }
}

function externalKey(provider: string, guid: string): string {
  return `${provider}|${guid}`;
}
