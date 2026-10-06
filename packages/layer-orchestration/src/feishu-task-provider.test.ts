/**
 * feishu-task-provider 单测：分组→统一状态投影、扫描域（分组/未分组/游标续传/
 * 清单过滤）、归属解析、契约形状。feishu 调用全部走假桩，不触网。
 */
import { describe, it, expect } from "vitest";
import {
  SECTION_TO_STATUS,
  FEISHU_TASK_PROVIDER_ID,
  projectRefFromSummary,
  collectFeishuTasks,
  createFeishuTaskProvider,
} from "./feishu-task-provider.js";
import { SECTION_NAMES } from "./task-issue-sync.js";
import type { FeishuApiResultLike, FeishuCall } from "./feishu-task-provider.js";

// ── 假桩：按 path 前缀返回固定的三清单世界 ─────────────────────────

const WORLD = {
  tasklists: [
    { name: "AIGility-Cloud-Innovation", guid: "list-org" },
    { name: "TiMEM-AI", guid: "list-timem" },
    { name: "研发任务管理", guid: "list-personal" },
  ],
  sections: {
    "list-org": [
      { name: SECTION_NAMES.plan, guid: "sec-org-p" },
      { name: SECTION_NAMES.check, guid: "sec-org-c" },
    ],
    "list-timem": [{ name: SECTION_NAMES.doing, guid: "sec-timem-d" }],
  },
  sectionTasks: {
    "sec-org-p": [
      { guid: "t-1", summary: "[AIGility-Cloud-Innovation/nx-telecom-opc-platform] OPC社区网站UI优化", url: "https://applink.feishu.cn/todo/t-1" },
    ],
    "sec-org-c": [
      { guid: "t-2", summary: "[AIGility-Cloud-Innovation/nx-telecom-opc-platform#25] VECTOR_MIN_SCORE 配置化" },
    ],
    "sec-timem-d": [
      { guid: "t-3", summary: "手工裸任务：没有归属前缀" },
    ],
  },
  listTasks: {
    "list-org": [
      { guid: "t-1", summary: "[AIGility-Cloud-Innovation/nx-telecom-opc-platform] OPC社区网站UI优化" },
      { guid: "t-2", summary: "[AIGility-Cloud-Innovation/nx-telecom-opc-platform#25] VECTOR_MIN_SCORE 配置化" },
      { guid: "t-9", summary: "[AIGility-Cloud-Innovation/nx-telecom-opc-platform#100] 未分组的双建任务" },
    ],
    "list-timem": [{ guid: "t-3", summary: "手工裸任务：没有归属前缀" }],
    "list-personal": [],
  },
};

const okData = (data: unknown): FeishuApiResultLike => ({ ok: true, value: { code: 0, msg: "", data } });

const fakeCall: FeishuCall = async (req) => {
  const path = String(req["path"] ?? "");
  if (path === "/open-apis/task/v2/tasklists") return okData({ items: WORLD.tasklists });
  if (path === "/open-apis/task/v2/sections") {
    const id = (req["query"] as Record<string, unknown>)?.["resource_id"];
    return okData({ items: (WORLD.sections as Record<string, unknown>)[String(id)] ?? [] });
  }
  const sec = path.match(/\/sections\/([^/]+)\/tasks/)?.[1];
  if (sec) return okData({ items: (WORLD.sectionTasks as Record<string, unknown>)[sec] ?? [] });
  const list = path.match(/\/tasklists\/([^/]+)\/tasks/)?.[1];
  if (list) return okData({ items: (WORLD.listTasks as Record<string, unknown>)[list] ?? [] });
  return { ok: false, error: `unexpected path ${path}` };
};

// ── 投影与解析 ───────────────────────────────────────────────────

describe("SECTION_TO_STATUS 投影", () => {
  it("P/D/C/A 四分组映射与契约注释一致", () => {
    expect(SECTION_TO_STATUS[SECTION_NAMES.plan]).toBe("planned");
    expect(SECTION_TO_STATUS[SECTION_NAMES.doing]).toBe("dispatched");
    expect(SECTION_TO_STATUS[SECTION_NAMES.check]).toBe("review");
    expect(SECTION_TO_STATUS[SECTION_NAMES.fix]).toBe("failed");
  });

  it("未知分组返回 undefined", () => {
    expect(SECTION_TO_STATUS["某个自建分组"]).toBeUndefined();
    expect(createFeishuTaskProvider(fakeCall).mapStatus("某个自建分组")).toBeUndefined();
  });
});

describe("projectRefFromSummary 归属解析", () => {
  it("[org/repo] 前缀与 [org/repo#N] 双建标题都能解析", () => {
    expect(projectRefFromSummary("[TiMEM-AI/timem_frontend] 优化图片加载")).toBe("TiMEM-AI/timem_frontend");
    expect(projectRefFromSummary("[AIGility-Cloud-Innovation/nx-telecom-opc-platform#25] 配置化")).toBe(
      "AIGility-Cloud-Innovation/nx-telecom-opc-platform",
    );
  });
  it("无前缀返回 undefined", () => {
    expect(projectRefFromSummary("修一下登录页")).toBeUndefined();
    expect(projectRefFromSummary(undefined)).toBeUndefined();
  });
});

// ── 扫描域 ───────────────────────────────────────────────────────

describe("collectFeishuTasks 扫描", () => {
  it("分组任务带分组状态投影，未分组任务落 planned", async () => {
    const got = await collectFeishuTasks(fakeCall);
    const byGuid = new Map(got.map((c) => [c.origin.guid, c]));

    expect(byGuid.get("t-1")?.status).toBe("planned"); // P 计划中
    expect(byGuid.get("t-2")?.status).toBe("review"); // C 待测试
    expect(byGuid.get("t-3")?.status).toBe("dispatched"); // D 执行中
    expect(byGuid.get("t-9")?.status).toBe("planned"); // 未分组收编
  });

  it("origin/链接/归属按约定填充，分组任务不被未分组扫描重复吐出", async () => {
    const got = await collectFeishuTasks(fakeCall);
    const t1 = got.find((c) => c.origin.guid === "t-1");
    expect(t1?.origin.provider).toBe(FEISHU_TASK_PROVIDER_ID);
    expect(t1?.origin.url).toBe("https://applink.feishu.cn/todo/t-1");
    expect(t1?.projectRef).toBe("AIGility-Cloud-Innovation/nx-telecom-opc-platform");
    expect(got.filter((c) => c.origin.guid === "t-1")).toHaveLength(1);
  });

  it("tasklistNames 白名单过滤", async () => {
    const got = await collectFeishuTasks(fakeCall, { tasklistNames: ["TiMEM-AI"] });
    expect(got.map((c) => c.origin.guid)).toEqual(["t-3"]);
  });

  it("游标续传：value=断点清单 guid 时跳过其前（含自身）", async () => {
    const got = await collectFeishuTasks(fakeCall, {}, { provider: FEISHU_TASK_PROVIDER_ID, value: "list-org" });
    expect(got.map((c) => c.origin.guid).sort()).toEqual(["t-3"]);
  });
});

describe("createFeishuTaskProvider 契约形状", () => {
  it("collect=true execute=false，collect 可迭代吐候选", async () => {
    const p = createFeishuTaskProvider(fakeCall);
    expect(p.id).toBe(FEISHU_TASK_PROVIDER_ID);
    expect(p.capabilities).toEqual({ collect: true, execute: false });
    expect(p.execute).toBeUndefined();
    expect(p.sync).toBeUndefined();
    const out = [];
    for await (const c of p.collect!()) out.push(c);
    expect(out).toHaveLength(4);
  });
});
