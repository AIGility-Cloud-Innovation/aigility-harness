/** requirement-store 单测: CAS 流转 / 会话状态 / 持久化恢复 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RequirementStore } from "./requirement-store.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function storeWithFile(): { store: RequirementStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "req-store-"));
  tmpDirs.push(dir);
  return { store: new RequirementStore(join(dir, "state.json")), dir };
}

describe("RequirementStore", () => {
  it("append → open, 会话初始化为 collecting", () => {
    const s = new RequirementStore();
    const r = s.append("sess-1", "深色模式", "页面要加个深色模式");
    expect(r.status).toBe("open");
    expect(s.listOpen("sess-1")).toHaveLength(1);
    expect(s.session("sess-1").phase).toBe("collecting");
    expect(s.session("sess-1").hasNewSinceConsolidation).toBe(true);
  });

  it("CAS: open→merged 成功且带 mergedInto; 重复转移失败", () => {
    const s = new RequirementStore();
    const a = s.append("sess-1", "导出 Excel", "用户列表要能导出 Excel");
    const target = s.append("sess-1", "导出含头像", "导出的 Excel 里带头像链接");
    const okRes = s.transition(a.id, "open", "merged", { mergedInto: target.id });
    expect(okRes.ok).toBe(true);
    // 再次转移: 已是 merged, CAS 失败
    const again = s.transition(a.id, "open", "dropped");
    expect(again.ok).toBe(false);
    // merged 是终态, 无合法出边
    const bad = s.transition(a.id, "merged", "tasked");
    expect(bad.ok).toBe(false);
  });

  it("非法转移 open→open 被转移表拒绝", () => {
    const s = new RequirementStore();
    const r = s.append("sess-1", "x", "x");
    expect(s.transition(r.id, "open", "open").ok).toBe(false);
  });

  it("dropped 可被推翻回 open (用户确认页推翻无效判定)", () => {
    const s = new RequirementStore();
    const r = s.append("sess-1", "x", "x");
    expect(s.transition(r.id, "open", "dropped").ok).toBe(true);
    expect(s.transition(r.id, "dropped", "open").ok).toBe(true);
    expect(s.listOpen("sess-1")).toHaveLength(1);
  });

  it("listOpen 按创建时间排序且只含本会话", () => {
    const s = new RequirementStore();
    const a = s.append("sess-1", "a", "a");
    s.append("sess-2", "other", "other");
    const b = s.append("sess-1", "b", "b");
    expect(s.listOpen("sess-1").map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("saveConsolidation 清 hasNew; latestConsolidation 取最高版本", () => {
    const s = new RequirementStore();
    const r = s.append("sess-1", "a", "a");
    void r;
    const base = {
      sessionId: "sess-1",
      items: [],
      designDoc: "d",
      executionOrder: [],
      orderIsFallback: false,
    };
    s.saveConsolidation({ ...base, id: "c1", version: 1, createdAt: 1 });
    expect(s.session("sess-1").hasNewSinceConsolidation).toBe(false);
    s.saveConsolidation({ ...base, id: "c2", version: 2, createdAt: 2 });
    expect(s.latestConsolidation("sess-1")?.version).toBe(2);
  });

  it("flush + recover: 落盘后新实例恢复需求与会话阶段", () => {
    const { store, dir } = storeWithFile();
    const a = store.append("sess-1", "深色模式", "页面要加个深色模式");
    store.append("sess-1", "优化登录", "登录太慢了");
    store.transition(a.id, "open", "tasked");
    store.setPhase("sess-1", "confirming");
    store.flushSync();

    const revived = new RequirementStore(join(dir, "state.json"));
    expect(revived.recover()).toBe(2);
    expect(revived.listOpen("sess-1")).toHaveLength(1);
    expect(revived.listAll("sess-1").find((r) => r.id === a.id)?.status).toBe("tasked");
    expect(revived.session("sess-1").phase).toBe("confirming");
  });

  it("recover: 文件不存在返回 0 且不抛错", () => {
    const { store } = storeWithFile();
    expect(new RequirementStore(undefined).recover()).toBe(0);
    expect(store.recover()).toBe(0);
  });
});
