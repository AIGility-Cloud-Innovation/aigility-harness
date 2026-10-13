/**
 * task-registry 单测：发号收编去重、双向关联索引、CAS 状态机、
 * list 过滤、JSON 落盘恢复（requirement-store 同款模式）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry } from "./task-registry.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "task-registry-")), "tasks.json");
}

function feishuTask(guid: string) {
  return { provider: "feishu-task", guid, url: `https://applink.feishu.cn/client/todo/detail?guid=${guid}` };
}

describe("TaskRegistry 收编与发号", () => {
  it("adopt 发号 tsk_ 前缀 uid，origin 同步进 links，默认 planned", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "修登录页", origin: feishuTask("guid-1") });
    expect(r.uid).toMatch(/^tsk_[0-9a-f-]{36}$/);
    expect(r.status).toBe("planned");
    expect(r.links["feishu-task"]?.guid).toBe("guid-1");
    expect(r.origin.guid).toBe("guid-1");
  });

  it("同 origin 重复收编返回既有记录（不重复发号）", () => {
    const reg = new TaskRegistry();
    const a = reg.adopt({ title: "修登录页", origin: feishuTask("guid-1") });
    const b = reg.adopt({ title: "修登录页（改标题也不算新任务）", origin: feishuTask("guid-1") });
    expect(b.uid).toBe(a.uid);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("TaskRegistry 关联句柄", () => {
  it("link 挂实施侧句柄后正反查均可达", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "优化账单导出", origin: feishuTask("guid-2"), projectRef: "TiMEM-AI/timem-platform-backend" });
    const linked = reg.link(r.uid, "gitea-issue", { guid: "TiMEM-AI/timem-platform-backend#100", url: "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/issues/100" });
    expect(linked.ok).toBe(true);
    expect(reg.link(r.uid, "agentd", { guid: "agt-task-9" }).ok).toBe(true);

    expect(reg.findByExternal("gitea-issue", "TiMEM-AI/timem-platform-backend#100")?.uid).toBe(r.uid);
    expect(reg.findByExternal("agentd", "agt-task-9")?.uid).toBe(r.uid);
    expect(reg.findByExternal("feishu-task", "guid-2")?.uid).toBe(r.uid);
    expect(reg.list({ linkedProvider: "agentd" })).toHaveLength(1);
    expect(reg.list({ linkedProvider: "jira" })).toHaveLength(0);
  });

  it("link 未知 uid 返回 err", () => {
    const reg = new TaskRegistry();
    expect(reg.link("tsk_missing", "agentd", { guid: "x" }).ok).toBe(false);
  });
});

describe("TaskRegistry 状态机", () => {
  it("主链 planned→ready→dispatched→running→review→done 全通", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "主链", origin: feishuTask("guid-3") });
    for (const next of ["ready", "dispatched", "running", "review", "done"] as const) {
      const res = reg.transition(r.uid, next);
      expect(res.ok).toBe(true);
    }
    expect(reg.get(r.uid)?.status).toBe("done");
  });

  it("非法转移被拒（planned→running、done→任意）", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "守门", origin: feishuTask("guid-4") });
    expect(reg.transition(r.uid, "running").ok).toBe(false);
    reg.transition(r.uid, "ready");
    reg.transition(r.uid, "cancelled");
    expect(reg.transition(r.uid, "ready").ok).toBe(false);
  });

  it("CAS：expect 不符返回 err 且状态不变", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "CAS", origin: feishuTask("guid-5") });
    const res = reg.transition(r.uid, "ready", "dispatched");
    expect(res.ok).toBe(false);
    expect(reg.get(r.uid)?.status).toBe("planned");
  });

  it("同状态重放幂等", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "幂等", origin: feishuTask("guid-6") });
    expect(reg.transition(r.uid, "planned").ok).toBe(true);
  });

  it("决策暂停/续跑：running→needs-input→running（2026-10-13 状态机；不算失败，可同上下文续跑）", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "决策", origin: feishuTask("guid-d1") });
    for (const next of ["ready", "dispatched", "running"] as const) reg.transition(r.uid, next);
    expect(reg.transition(r.uid, "needs-input").ok).toBe(true); // 暂停等人工决策
    expect(reg.get(r.uid)?.status).toBe("needs-input");
    // needs-input 不落 failed（failover/提醒口径区分），但可重入 running 续跑
    expect(reg.transition(r.uid, "running").ok).toBe(true);
    expect(reg.get(r.uid)?.status).toBe("running");
    // 非法跳转：needs-input→done 被拒
    expect(reg.transition(r.uid, "needs-input").ok).toBe(true);
    expect(reg.transition(r.uid, "done").ok).toBe(false);
  });

  it("验收打回与失败重做回边可用", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "回边", origin: feishuTask("guid-7") });
    for (const next of ["ready", "dispatched", "running", "review"] as const) reg.transition(r.uid, next);
    expect(reg.transition(r.uid, "ready").ok).toBe(true); // review→ready 打回
    reg.transition(r.uid, "dispatched");
    reg.transition(r.uid, "running");
    expect(reg.transition(r.uid, "failed").ok).toBe(true);
    expect(reg.transition(r.uid, "ready").ok).toBe(true); // failed→ready 重做
  });
});

describe("TaskRegistry 持久化", () => {
  it("flushSync 落盘后新实例 recover 恢复记录与反查索引", () => {
    const file = tmpFile();
    const reg = new TaskRegistry(file);
    const r = reg.adopt({ title: "落盘", origin: feishuTask("guid-8"), projectRef: "org/repo" });
    reg.link(r.uid, "agentd", { guid: "agt-1" });
    reg.transition(r.uid, "ready");
    reg.flushSync();

    const reg2 = new TaskRegistry(file);
    expect(reg2.recover()).toBe(1);
    expect(reg2.get(r.uid)?.status).toBe("ready");
    expect(reg2.findByExternal("agentd", "agt-1")?.uid).toBe(r.uid);
    expect(reg2.findByExternal("feishu-task", "guid-8")?.projectRef).toBe("org/repo");
  });

  it("无文件路径时纯内存可用", () => {
    const reg = new TaskRegistry();
    reg.adopt({ title: "内存", origin: feishuTask("guid-9") });
    expect(reg.list()).toHaveLength(1);
    expect(reg.flushSync()).toBeUndefined();
  });
});

describe("TaskRegistry list 过滤", () => {
  it("status/projectRef/linkedProvider 组合过滤", () => {
    const reg = new TaskRegistry();
    const a = reg.adopt({ title: "A", origin: feishuTask("guid-a"), projectRef: "org/x" });
    const b = reg.adopt({ title: "B", origin: feishuTask("guid-b"), projectRef: "org/y" });
    reg.transition(b.uid, "ready");
    reg.link(a.uid, "agentd", { guid: "agt-a" });

    expect(reg.list({ status: ["planned"] }).map((r) => r.uid)).toEqual([a.uid]);
    expect(reg.list({ projectRef: "org/y" }).map((r) => r.uid)).toEqual([b.uid]);
    expect(reg.list({ status: ["ready"], projectRef: "org/y" })).toHaveLength(1);
    expect(reg.list({ status: ["ready"], projectRef: "org/x" })).toHaveLength(0);
  });
});

// ── 执行独占（收集全对齐，执行单 provider） ─────────────────────────

describe("TaskRegistry claim 执行独占", () => {
  it("claim 原子领取：ready→dispatched + 独占声明一步完成", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "派发", origin: feishuTask("guid-c1") });
    reg.transition(r.uid, "ready");
    const res = reg.claim(r.uid, "agentd-task", "agt-1");
    expect(res.ok).toBe(true);
    expect(reg.get(r.uid)?.status).toBe("dispatched");
    expect(reg.get(r.uid)?.assigned).toMatchObject({ provider: "agentd-task", handle: "agt-1" });
  });

  it("已被 A 独占时 B 的 claim 被拒；同 provider 可幂等重放", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "独占", origin: feishuTask("guid-c2") });
    reg.transition(r.uid, "ready");
    expect(reg.claim(r.uid, "agentd-task", "agt-1").ok).toBe(true);
    expect(reg.claim(r.uid, "gitea-issue", "org/repo#1").ok).toBe(false); // 拒绝改派
    expect(reg.claim(r.uid, "agentd-task", "agt-1", "dispatched").ok).toBe(true); // 幂等
    expect(reg.get(r.uid)?.assigned?.provider).toBe("agentd-task");
  });

  it("打回/取消清除独占，允许重新派发；running→review 保留", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "回边", origin: feishuTask("guid-c3") });
    reg.transition(r.uid, "ready");
    reg.claim(r.uid, "agentd-task", "agt-1");
    reg.transition(r.uid, "running");
    expect(reg.get(r.uid)?.assigned?.provider).toBe("agentd-task"); // 执行中保留
    reg.transition(r.uid, "failed");
    expect(reg.get(r.uid)?.assigned?.provider).toBe("agentd-task"); // 失败保留（追溯）
    reg.transition(r.uid, "ready"); // 重做
    expect(reg.get(r.uid)?.assigned).toBeUndefined();
    expect(reg.claim(r.uid, "gitea-issue", "org/repo#9").ok).toBe(true); // 可改派真人
  });
});

// ── 对齐原语：merge 与不变量巡检 ────────────────────────────────────

describe("TaskRegistry merge 与 invariantViolations", () => {
  it("merge 迁移句柄并重指反查索引，absorb 删除", () => {
    const reg = new TaskRegistry();
    const keep = reg.adopt({ title: "工单主体", origin: { provider: "gitea-issue", guid: "org/repo#5" } });
    const absorb = reg.adopt({ title: "[org/repo#5] 飞书侧", origin: feishuTask("guid-m1") });
    const res = reg.merge(keep.uid, absorb.uid);
    expect(res.ok).toBe(true);
    expect(reg.get(absorb.uid)).toBeUndefined();
    expect(reg.findByExternal("feishu-task", "guid-m1")?.uid).toBe(keep.uid); // 索引重指
    expect(reg.get(keep.uid)?.links["feishu-task"]?.guid).toBe("guid-m1");
    expect(reg.invariantViolations()).toEqual([]);
  });

  it("合并自身/缺失记录返回 err", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "x", origin: feishuTask("guid-m2") });
    expect(reg.merge(r.uid, r.uid).ok).toBe(false);
    expect(reg.merge(r.uid, "tsk_missing").ok).toBe(false);
  });

  it("越权写入可在巡检中暴露（divergence）", () => {
    const reg = new TaskRegistry();
    const a = reg.adopt({ title: "A", origin: feishuTask("guid-i1") });
    const b = reg.adopt({ title: "B", origin: feishuTask("guid-i2") });
    // 模拟脏数据：把 A 已持有的句柄覆盖挂到 B 的 links 上（绕过 adopt/link 正常路径）
    b.links["feishu-task"] = { guid: "guid-i1" };
    const vs = reg.invariantViolations();
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ kind: "divergence", uid: b.uid, indexedTo: a.uid });
  });
});

describe("TaskRegistry update 复核补齐", () => {
  it("更新归属/描述幂等可重放；未知 uid 报错", () => {
    const reg = new TaskRegistry();
    const r = reg.adopt({ title: "x", origin: feishuTask("guid-u1") });
    expect(reg.update(r.uid, { projectRef: "org/repo", description: "执行者：张三" }).ok).toBe(true);
    expect(reg.update(r.uid, { projectRef: "org/repo" }).ok).toBe(true); // 重放
    expect(reg.get(r.uid)?.projectRef).toBe("org/repo");
    expect(reg.get(r.uid)?.description).toBe("执行者：张三");
    expect(reg.update("tsk_missing", { title: "y" }).ok).toBe(false);
  });
});
