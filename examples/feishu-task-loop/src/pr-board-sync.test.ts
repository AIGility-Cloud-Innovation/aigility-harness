/** pr-board-sync.test.ts — agent 任务 P/D/C/A 投影与失败播报幂等测试。 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry } from "@aigility-harness/layer-orchestration";
import {
  buildFailureNotice,
  isAgentTaskRecord,
  sectionKeyForStatus,
  syncPrDeliveredTasks,
} from "./pr-board-sync.js";

function tempFiles(): { projectionFile: string; stateFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "feishu-board-sync-"));
  return { projectionFile: join(dir, "projection.json"), stateFile: join(dir, "state.json") };
}

function fakeFeishu(currentSection = "P") {
  return vi.fn(async (req: Record<string, unknown>) => {
    const path = String(req.path);
    if (path === "/open-apis/task/v2/tasklists") {
      return { ok: true, value: { code: 0, data: { items: [{ guid: "list-1" }] } } };
    }
    if (path === "/open-apis/task/v2/tasklists/list-1/tasks") {
      return { ok: true, value: { code: 0, data: { items: [{ guid: "feishu-1" }] } } };
    }
    if (path === "/open-apis/task/v2/sections") {
      return {
        ok: true,
        value: {
          code: 0,
          data: {
            items: [
              { guid: "sec-p", name: "P 计划中" },
              { guid: "sec-d", name: "D 执行中" },
              { guid: "sec-c", name: "C 待测试" },
              { guid: "sec-a", name: "A 待修复" },
            ],
          },
        },
      };
    }
    if (/^\/open-apis\/task\/v2\/sections\/sec-[pdca]\/tasks$/.test(path)) {
      const key = path.includes("sec-p") ? "P" : path.includes("sec-d") ? "D" : path.includes("sec-c") ? "C" : "A";
      return {
        ok: true,
        value: { code: 0, data: { items: key === currentSection ? [{ guid: "feishu-1" }] : [] } },
      };
    }
    if (path.endsWith("/add_tasklist")) return { ok: true, value: { code: 0 } };
    return { ok: true, value: { code: 0, data: {} } };
  });
}

describe("sectionKeyForStatus", () => {
  it("按台账状态投影 P/D/C/A", () => {
    expect(sectionKeyForStatus("planned")).toBe("P");
    expect(sectionKeyForStatus("ready")).toBe("P");
    expect(sectionKeyForStatus("dispatched")).toBe("D");
    expect(sectionKeyForStatus("running")).toBe("D");
    expect(sectionKeyForStatus("review")).toBe("C");
    expect(sectionKeyForStatus("failed")).toBe("A");
    expect(sectionKeyForStatus("done")).toBeUndefined();
  });
});

describe("isAgentTaskRecord", () => {
  it("识别标题/描述/工人句柄，真人负责人优先排除", () => {
    expect(isAgentTaskRecord({ title: "【agent】[o/r] x", description: "" })).toBe(true);
    expect(isAgentTaskRecord({ title: "x", description: "执行者：agent" })).toBe(true);
    expect(isAgentTaskRecord({ title: "x", description: "", assigned: { provider: "worker-team/codex", handle: "/tmp/wt", at: 1 } })).toBe(true);
    expect(isAgentTaskRecord({ title: "【agent】x", description: "", assignee_member_id: "member-a" })).toBe(false);
  });
});

describe("syncPrDeliveredTasks", () => {
  it("review 卡片挪 C 并写预期投影，board-sync 不会反向抢态", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 待验收",
      status: "review",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    const call = fakeFeishu("P");
    const actions = await syncPrDeliveredTasks(reg, call, files);
    expect(actions).toContain("挪C:【agent】[o/r] 待验收");
    expect(JSON.parse(readFileSync(files.projectionFile, "utf-8"))[rec.uid]).toBe("C");
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      path: "/open-apis/task/v2/tasks/feishu-1/add_tasklist",
      body: { tasklist_guid: "list-1", section_guid: "sec-c" },
    }));
  });

  it("解除依赖 worker-team note：普通 agent review 卡也投影", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    reg.adopt({
      title: "【agent】[o/r] 普通交付",
      status: "review",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    const actions = await syncPrDeliveredTasks(reg, fakeFeishu("P"), files);
    expect(actions[0]).toMatch(/^挪C:/);
  });

  it("错仓 review 卡：转 failed 挪 A，不补链接不播报", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 错仓交付",
      status: "review",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.update(rec.uid, { note: "[worker-team/codex] 完成 https://git.aigility.cloud/o/other/pulls/5" });
    const sendGroup = vi.fn(async () => true);
    const actions = await syncPrDeliveredTasks(reg, fakeFeishu("P"), { ...files, sendGroup });
    expect(actions).toContain("挪A:【agent】[o/r] 错仓交付");
    expect(reg.list({ status: ["failed"] }).map((x) => x.uid)).toContain(rec.uid);
    expect(actions.some((a) => a.startsWith("补PR链:"))).toBe(false);
    expect(sendGroup).not.toHaveBeenCalled();
  });

  it("同仓组合标题卡（【agent】[o/r]+PR同仓）正常挪 C 并补链接", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 组合标题交付",
      status: "review",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.update(rec.uid, { note: "[worker-team/codex] 完成 https://git.aigility.cloud/o/r/pulls/7" });
    const actions = await syncPrDeliveredTasks(reg, fakeFeishu("P"), files);
    expect(actions).toContain("挪C:【agent】[o/r] 组合标题交付");
    expect(actions.some((a) => a.startsWith("补PR链:"))).toBe(true);
  });

  it("已有 PR 链接兜底补写描述（幂等）", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] PR 卡",
      status: "review",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.update(rec.uid, { note: "[worker-team/codex] 完成 https://git.aigility.cloud/o/r/pulls/12" });
    const descriptions = ["原描述"];
    const call = vi.fn(async (req: Record<string, unknown>) => {
      const path = String(req.path);
      if (path === "/open-apis/task/v2/tasklists") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "list-1" }] } } };
      }
      if (path === "/open-apis/task/v2/tasklists/list-1/tasks") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "feishu-1" }] } } };
      }
      if (path === "/open-apis/task/v2/sections") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "sec-c", name: "C 待测试" }] } } };
      }
      if (path === "/open-apis/task/v2/sections/sec-c/tasks") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "feishu-1" }] } } };
      }
      if (path === "/open-apis/task/v2/tasks/feishu-1" && req.method === "GET") {
        return { ok: true, value: { code: 0, data: { description: descriptions[0] } } };
      }
      if (path === "/open-apis/task/v2/tasks/feishu-1" && req.method === "PATCH") {
        descriptions[0] = (req.body as { task: { description: string } }).task.description;
        return { ok: true, value: { code: 0 } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const first = await syncPrDeliveredTasks(reg, call, files);
    expect(first).toContain("补PR链:【agent】[o/r] PR 卡←12");
    expect(descriptions[0]).toContain("🔗 交付 PR：https://git.aigility.cloud/o/r/pulls/12");
    const second = await syncPrDeliveredTasks(reg, call, files);
    expect(second.some((a) => a.startsWith("补PR链:"))).toBe(false);
  });

  it("failed 卡补失败原因进描述（幂等，重复拍不重复补）", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 超时任务",
      status: "ready",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.transition(rec.uid, "dispatched");
    reg.transition(rec.uid, "running");
    reg.transition(rec.uid, "failed");
    reg.update(rec.uid, { note: "[worker-team] 失败：codex: codex-agent: timed out after 1800000ms" });
    const descriptions = [""];
    const call = vi.fn(async (req: Record<string, unknown>) => {
      const path = String(req.path);
      if (path === "/open-apis/task/v2/tasklists") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "list-1" }] } } };
      }
      if (path === "/open-apis/task/v2/tasklists/list-1/tasks") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "feishu-1" }] } } };
      }
      if (path === "/open-apis/task/v2/sections") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "sec-a", name: "A 待修复" }] } } };
      }
      if (path === "/open-apis/task/v2/sections/sec-a/tasks") {
        return { ok: true, value: { code: 0, data: { items: [{ guid: "feishu-1" }] } } };
      }
      if (path === "/open-apis/task/v2/tasks/feishu-1" && req.method === "GET") {
        return { ok: true, value: { code: 0, data: { description: descriptions[0] } } };
      }
      if (path === "/open-apis/task/v2/tasks/feishu-1" && req.method === "PATCH") {
        descriptions[0] = (req.body as { task: { description: string } }).task.description;
        return { ok: true, value: { code: 0 } };
      }
      return { ok: true, value: { code: 0, data: {} } };
    });
    const first = await syncPrDeliveredTasks(reg, call, files);
    expect(first.some((a) => a.startsWith("补败因:"))).toBe(true);
    expect(descriptions[0]).toContain("❌ 最近失败（");
    expect(descriptions[0]).toContain("timed out after 1800000ms");
    expect(descriptions[0]).toContain("挪 D");
    const second = await syncPrDeliveredTasks(reg, call, files);
    expect(second.some((a) => a.startsWith("补败因:"))).toBe(false);
    expect((descriptions[0].match(/❌ 最近失败/g) ?? []).length).toBe(1);
  });

  it("ready 且预期截面 D（人工挪 D 重跑）：不拉回 P", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 重跑任务",
      status: "ready",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    writeFileSync(files.projectionFile, JSON.stringify({ [rec.uid]: "D" }));
    const call = fakeFeishu("D");
    const actions = await syncPrDeliveredTasks(reg, call, files);
    expect(actions.some((a) => a.startsWith("挪P:"))).toBe(false);
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/open-apis/task/v2/tasks/feishu-1/add_tasklist",
      body: { tasklist_guid: "list-1", section_guid: "sec-p" },
    }));
  });

  it("failed 卡片挪 A，失败播报只发一次；重新放行后再次失败可再发", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 撰写方案说明",
      status: "ready",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.transition(rec.uid, "dispatched");
    reg.transition(rec.uid, "running");
    reg.transition(rec.uid, "failed");
    reg.update(rec.uid, { note: "[worker-team/codex] 交付失败：codex 收尾超时" });
    const sendGroup = vi.fn(async () => true);
    const options = { ...files, sendGroup };

    const first = await syncPrDeliveredTasks(reg, fakeFeishu("D"), options);
    expect(first).toEqual(expect.arrayContaining([
      "挪A:【agent】[o/r] 撰写方案说明",
      "失败播报:【agent】[o/r] 撰写方案说明",
    ]));
    expect(sendGroup).toHaveBeenCalledTimes(1);
    expect(sendGroup.mock.calls[0]?.[0]).toContain("codex 收尾超时");
    expect(sendGroup.mock.calls[0]?.[0]).toContain("产出保留");
    expect(JSON.parse(readFileSync(files.projectionFile, "utf-8"))[rec.uid]).toBe("A");

    await syncPrDeliveredTasks(reg, fakeFeishu("A"), options);
    expect(sendGroup).toHaveBeenCalledTimes(1);

    reg.transition(rec.uid, "ready");
    reg.transition(rec.uid, "dispatched");
    reg.transition(rec.uid, "running");
    reg.transition(rec.uid, "failed");
    reg.update(rec.uid, { note: "[worker-team/codex] 交付失败：第二次失败" });
    await syncPrDeliveredTasks(reg, fakeFeishu("A"), options);
    expect(sendGroup).toHaveBeenCalledTimes(2);
    expect(sendGroup.mock.calls[1]?.[0]).toContain("第二次失败");
  });

  it("发送失败不记已播报，下拍重试", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    const rec = reg.adopt({
      title: "【agent】[o/r] 失败",
      status: "ready",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    reg.transition(rec.uid, "dispatched");
    reg.transition(rec.uid, "running");
    reg.transition(rec.uid, "failed");
    reg.update(rec.uid, { note: "boom" });
    const sendGroup = vi.fn(async () => false);
    await syncPrDeliveredTasks(reg, fakeFeishu("A"), { ...files, sendGroup });
    writeFileSync(files.projectionFile, JSON.stringify({ [rec.uid]: "A" }));
    await syncPrDeliveredTasks(reg, fakeFeishu("A"), { ...files, sendGroup });
    expect(sendGroup).toHaveBeenCalledTimes(2);
  });

  it("人工挂起的 agent 卡不被正向拉回 P", async () => {
    const files = tempFiles();
    const reg = new TaskRegistry();
    reg.adopt({
      title: "【agent】[o/r] 人工挪挂起",
      status: "planned",
      origin: { provider: "feishu-task", guid: "feishu-1" },
    });
    const call = fakeFeishu("P");
    const actions = await syncPrDeliveredTasks(reg, call, {
      ...files,
      projectedSection: () => "挂",
    });
    expect(actions.some((a) => a.startsWith("挪P:"))).toBe(false);
    expect(call).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/open-apis/task/v2/tasks/feishu-1/add_tasklist",
    }));
  });
});

describe("buildFailureNotice", () => {
  it("含标题、note 原因、worktree/分支/PR 保留位置", () => {
    const text = buildFailureNotice({
      uid: "tsk_abcdef",
      title: "【agent】[o/r] 失败任务",
      status: "failed",
      origin: { provider: "feishu-task", guid: "feishu-1" },
      links: {},
      note: "[worker-team/codex] 交付失败：测试失败 https://git.aigility.cloud/o/r/pulls/9",
      assigned: { provider: "worker-team/codex", handle: "/tmp/worktrees/r-abcdef", at: 1 },
      createdAt: 1,
      updatedAt: 2,
    });
    expect(text).toContain("失败任务");
    expect(text).toContain("测试失败");
    expect(text).toContain("/tmp/worktrees/r-abcdef");
    expect(text).toContain("agent/");
    expect(text).toContain("/pulls/9");
  });
});
