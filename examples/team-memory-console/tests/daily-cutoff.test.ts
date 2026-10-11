import { describe, expect, it } from "vitest";
import { filterTasksForDaily, taskUpdatedAtMs, type RegTask } from "../src/task-cards.js";

// 2026-10-12 日报口径：done 且当天更新过 = 当天完成；历史 done 不重报。不新增 completedAt 字段。

function task(partial: Partial<RegTask> & { uid: string; title: string }): RegTask {
  return { status: "planned", ...partial };
}

const DATE = "2026-10-12";
// 台账里两种时间形态并存：epoch-ms 数字 与 ISO 字符串
const MS = new Date("2026-10-12T15:30:00+08:00").getTime();

describe("taskUpdatedAtMs", () => {
  it("epoch 毫秒/秒与 ISO 字符串都能解析", () => {
    expect(taskUpdatedAtMs(task({ uid: "a", title: "t", updatedAt: MS }))).toBe(MS);
    expect(taskUpdatedAtMs(task({ uid: "b", title: "t", updatedAt: MS / 1000 }))).toBe(MS);
    expect(taskUpdatedAtMs(task({ uid: "c", title: "t", updatedAt: "2026-10-12T15:30:00+08:00" }))).toBe(MS);
  });

  it("缺省/垃圾值返回 null（不会误当当天完成）", () => {
    expect(taskUpdatedAtMs(task({ uid: "d", title: "t" }))).toBeNull();
    expect(taskUpdatedAtMs(task({ uid: "e", title: "t", updatedAt: "not-a-date" }))).toBeNull();
    expect(taskUpdatedAtMs(task({ uid: "f", title: "t", updatedAt: NaN }))).toBeNull();
  });
});

describe("filterTasksForDaily（done 按日收口）", () => {
  const tasks: RegTask[] = [
    task({ uid: "done-today-ms", title: "当天完成·毫秒", status: "done", updatedAt: MS }),
    task({ uid: "done-today-iso", title: "当天完成·ISO", status: "done", updatedAt: "2026-10-12T09:00:00+08:00" }),
    task({ uid: "done-yesterday", title: "昨天完成", status: "done", updatedAt: "2026-10-11T18:00:00+08:00" }),
    task({ uid: "done-no-ts", title: "历史完成·无时间戳", status: "done" }),
    task({ uid: "running", title: "进行中", status: "running", updatedAt: "2026-10-05T10:00:00+08:00" }),
    task({ uid: "blocked", title: "受阻", status: "blocked", updatedAt: "2026-10-01T10:00:00+08:00" }),
  ];

  it("done 只留当天更新的；非 done 状态照常保留", () => {
    const kept = filterTasksForDaily(tasks, DATE).map((t) => t.uid);
    expect(kept).toEqual(["done-today-ms", "done-today-iso", "running", "blocked"]);
  });

  it("cancelled 的排除是入口职责（入口先滤再进过滤器），本函数不重复处理", () => {
    const withCancelled = [...tasks, task({ uid: "cx", title: "已取消", status: "cancelled", updatedAt: MS })];
    expect(filterTasksForDaily(withCancelled, DATE).map((t) => t.uid)).toContain("cx");
  });

  it("边界：当天 00:00:00 含、次日 00:00:00 不含", () => {
    const boundary: RegTask[] = [
      task({ uid: "at-start", title: "零点整", status: "done", updatedAt: new Date(`${DATE}T00:00:00+08:00`).getTime() }),
      task({ uid: "next-day", title: "次日零点", status: "done", updatedAt: new Date("2026-10-13T00:00:00+08:00").getTime() }),
    ];
    expect(filterTasksForDaily(boundary, DATE).map((t) => t.uid)).toEqual(["at-start"]);
  });

  it("回看 10-11 日报：26 条 10-10 落账的 done 全部滤除，只剩当天完成", () => {
    const batch: RegTask[] = [
      task({ uid: "batch-done", title: "9月30日用量归属", status: "done", updatedAt: "2026-10-10T10:19:00+08:00" }),
      task({ uid: "new-done", title: "当天新完成", status: "done", updatedAt: "2026-10-11T20:00:00+08:00" }),
      task({ uid: "doing", title: "还在做", status: "review", updatedAt: "2026-10-11T09:00:00+08:00" }),
    ];
    const kept = filterTasksForDaily(batch, "2026-10-11").map((t) => t.uid);
    expect(kept).toEqual(["new-done", "doing"]);
  });
});
