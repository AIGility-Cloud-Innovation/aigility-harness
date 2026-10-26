/** stale-task-reminder.test.ts — 72h 人工滞留提醒/首跑静默/只提醒一次测试。 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityMember } from "@aigility-harness/layer-orchestration";
import type { TaskRecord } from "@aigility-harness/core";
import { buildStaleTaskNotice, remindStaleTasks } from "./stale-task-reminder.js";

const HOUR = 60 * 60_000;
const NOW = new Date("2026-10-26T12:00:00.000Z");

const member: IdentityMember = {
  member_id: "member-a",
  name: "张三",
  aliases: [],
  timem_user_ids: [],
  feishu_open_ids: ["ou_a"],
  gitea_usernames: [],
  wecom_user_ids: [],
  web_emails: [],
  match_source: {},
};

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    uid: "tsk_1",
    title: "人工任务",
    status: "dispatched",
    origin: { provider: "feishu-task", guid: "feishu-1" },
    links: { "feishu-task": { guid: "feishu-1" } },
    assignee_member_id: "member-a",
    createdAt: NOW.getTime() - 100 * HOUR,
    updatedAt: NOW.getTime() - 80 * HOUR,
    ...over,
  };
}

function registry(tasks: TaskRecord[]) {
  return { list: (q: { status: string[] }) => tasks.filter((t) => q.status.includes(t.status)) };
}

function stateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "stale-reminder-")), "state.json");
}

describe("buildStaleTaskNotice", () => {
  it("含滞留小时、@负责人、标题和最后变化时间", () => {
    const text = buildStaleTaskNotice(task(), member, NOW.getTime());
    expect(text).toContain("已 80 小时无进展");
    expect(text).toContain('<at user_id="ou_a">张三</at>');
    expect(text).toContain("人工任务");
    expect(text).toContain("当前：D 执行中");
  });

  it("负责人无 open_id 降级纯文本，不报错", () => {
    const text = buildStaleTaskNotice(task(), { ...member, feishu_open_ids: [] }, NOW.getTime());
    expect(text).toContain("负责人：张三");
    expect(text).not.toContain("<at user_id=");
  });
});

describe("remindStaleTasks", () => {
  it("首拍只写基线不发送；存量未变化不重复打扰", async () => {
    const file = stateFile();
    const sendGroup = vi.fn(async () => true);
    const opts = { stateFile: file, sendGroup, now: () => NOW, members: [member] };
    const first = await remindStaleTasks(registry([task()]), opts);
    expect(first).toEqual({ baselined: 1, sent: 0, failed: 0 });
    expect(sendGroup).not.toHaveBeenCalled();

    const second = await remindStaleTasks(registry([task()]), opts);
    expect(second).toEqual({ baselined: 0, sent: 0, failed: 0 });
    expect(sendGroup).not.toHaveBeenCalled();

    const third = await remindStaleTasks(registry([task()]), opts);
    expect(third).toEqual({ baselined: 0, sent: 0, failed: 0 });
    expect(sendGroup).not.toHaveBeenCalled();
  });

  it("未满 72h 不提醒；agentd 句柄与 agent 任务不监控", async () => {
    const file = stateFile();
    const sendGroup = vi.fn(async () => true);
    const opts = { stateFile: file, sendGroup, now: () => NOW, members: [member] };
    await remindStaleTasks(registry([]), opts);
    const result = await remindStaleTasks(registry([
      task({ uid: "recent", updatedAt: NOW.getTime() - 71 * HOUR }),
      task({ uid: "agentd", links: { "agentd-task": { guid: "agt-1" } } }),
      task({ uid: "agent", title: "【agent】机器任务" }),
    ]), opts);
    expect(result).toEqual({ baselined: 0, sent: 0, failed: 0 });
    expect(sendGroup).not.toHaveBeenCalled();
  });

  it("推进后再停滞 72h 可再次提醒", async () => {
    const file = stateFile();
    const sendGroup = vi.fn(async () => true);
    let now = NOW;
    const opts = { stateFile: file, sendGroup, now: () => now, members: [member] };
    await remindStaleTasks(registry([task()]), opts);
    await remindStaleTasks(registry([task()]), opts);
    expect(sendGroup).not.toHaveBeenCalled();

    now = new Date(NOW.getTime() + 10 * HOUR);
    const progressed = task({ updatedAt: NOW.getTime() - 10 * HOUR });
    expect(await remindStaleTasks(registry([progressed]), opts)).toEqual({ baselined: 0, sent: 0, failed: 0 });
    now = new Date(NOW.getTime() + 90 * HOUR);
    expect(await remindStaleTasks(registry([progressed]), opts)).toEqual({ baselined: 0, sent: 1, failed: 0 });
    expect(sendGroup).toHaveBeenCalledTimes(1);
  });

  it("负责人变更可再次提醒", async () => {
    const file = stateFile();
    const sendGroup = vi.fn(async () => true);
    let now = NOW;
    const opts = { stateFile: file, sendGroup, now: () => now, members: [member] };
    await remindStaleTasks(registry([task()]), opts);
    await remindStaleTasks(registry([task()]), opts);
    expect(sendGroup).not.toHaveBeenCalled();

    const changed = task({ assignee_member_id: "member-b" });
    expect((await remindStaleTasks(registry([changed]), opts)).sent).toBe(1);
    expect(sendGroup).toHaveBeenCalledTimes(1);
  });

  it("发送失败不记已提醒，下拍重试", async () => {
    const file = stateFile();
    const sendGroup = vi.fn(async () => false);
    let now = NOW;
    const opts = { stateFile: file, sendGroup, now: () => now, members: [member] };
    await remindStaleTasks(registry([]), opts); // 首拍初始化（无存量）
    expect((await remindStaleTasks(registry([task()]), opts)).failed).toBe(1);
    now = new Date(NOW.getTime() + HOUR);
    sendGroup.mockResolvedValueOnce(true);
    expect((await remindStaleTasks(registry([task()]), opts)).sent).toBe(1);
    expect(sendGroup).toHaveBeenCalledTimes(2);
  });
});
