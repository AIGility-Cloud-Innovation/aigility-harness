/**
 * 收集侧整合单测：GiteaIssueProvider / AgentdTaskProvider 的收集半边、
 * collectIntoRegistry 主干道（发号/去重统计、related 跨源关联、错误隔离）。
 * 全部走假桩，不触网。
 */
import { describe, it, expect } from "vitest";
import {
  createGiteaIssueProvider,
  collectGiteaIssues,
  issueGuid,
  GITEA_STATE_TO_STATUS,
  GITEA_ISSUE_PROVIDER_ID,
} from "./gitea-issue-provider.js";
import {
  createAgentdTaskProvider,
  collectAgentdTasks,
  issueHandleFromSource,
  AGENTD_STATUS_TO_UNIFIED,
  AGENTD_TASK_PROVIDER_ID,
} from "./agentd-task-provider.js";
import { collectIntoRegistry } from "./task-collector.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskProvider, CollectTaskInput } from "@aigility-harness/core";

// ── GiteaIssueProvider ───────────────────────────────────────────

function giteaStub(pages: Record<string, unknown[][]>, failRepos: string[] = []): { call: ReturnType<typeof vue>; calls: string[] } {
  const calls: string[] = [];
  function vue(req: Record<string, unknown>) {
    calls.push(String(req["path"]));
    const repo = String(req["path"]).match(/\/repos\/(.+)\/issues/)![1];
    if (failRepos.includes(repo)) return Promise.resolve({ ok: false, error: "boom" });
    const q = req["query"] as Record<string, unknown>;
    const key = `${repo}:p${q?.["page"] ?? 1}`;
    return Promise.resolve({ ok: true, value: { status: 200, data: pages[key] ?? [] } });
  }
  return { call: vue as never, calls };
}

describe("GiteaIssueProvider 收集半边", () => {
  it("open 工单映射候选（guid/projectRef/url），PR 被过滤", async () => {
    const { call } = giteaStub({
      "org/repo:p1": [
        { number: 1, title: "首页跳转优化", state: "open", html_url: "https://git/org/repo/issues/1" },
        { number: 2, title: "这是个PR", state: "open", pull_request: { url: "x" } },
      ],
    });
    const got = await collectGiteaIssues(call, { repos: ["org/repo"] });
    expect(got).toHaveLength(1);
    expect(got[0].origin).toEqual({
      provider: GITEA_ISSUE_PROVIDER_ID,
      guid: "org/repo#1",
      url: "https://git/org/repo/issues/1",
    });
    expect(got[0].projectRef).toBe("org/repo");
    expect(got[0].status).toBe("planned");
  });

  it("满页自动翻页，未满页停止", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ number: i + 1, title: `t${i}`, state: "open" }));
    const { call } = giteaStub({ "org/repo:p1": full, "org/repo:p2": [{ number: 99, title: "尾页", state: "open" }] });
    const got = await collectGiteaIssues(call, { repos: ["org/repo"] });
    expect(got).toHaveLength(51);
  });

  it("state 映射 open→planned closed→done；仓库失败不抛出", async () => {
    expect(GITEA_STATE_TO_STATUS["open"]).toBe("planned");
    expect(GITEA_STATE_TO_STATUS["closed"]).toBe("done");
    const { call } = giteaStub({ "org/ok:p1": [{ number: 7, title: "ok", state: "open" }] }, ["org/bad"]);
    const got = await collectGiteaIssues(call, { repos: ["org/bad", "org/ok"] });
    expect(got.map((c) => c.origin.guid)).toEqual([issueGuid("org/ok", 7)]);
  });

  it("契约形状：仅收集", () => {
    const { call } = giteaStub({});
    const p = createGiteaIssueProvider(call, { repos: [] });
    expect(p.capabilities).toEqual({ collect: true, execute: false });
    expect(p.mapStatus("open")).toBe("planned");
  });
});

// ── AgentdTaskProvider ───────────────────────────────────────────

describe("AgentdTaskProvider 收集半边", () => {
  it("九态映射齐备（pending 两拼写归 dispatched）", () => {
    expect(AGENTD_STATUS_TO_UNIFIED["pending_confirmation"]).toBe("dispatched");
    expect(AGENTD_STATUS_TO_UNIFIED["pending_confirm"]).toBe("dispatched");
    expect(AGENTD_STATUS_TO_UNIFIED["queued"]).toBe("dispatched");
    expect(AGENTD_STATUS_TO_UNIFIED["running"]).toBe("running");
    expect(AGENTD_STATUS_TO_UNIFIED["needs_review"]).toBe("review");
    expect(AGENTD_STATUS_TO_UNIFIED["completed"]).toBe("done");
    expect(AGENTD_STATUS_TO_UNIFIED["failed"]).toBe("failed");
    expect(AGENTD_STATUS_TO_UNIFIED["blocked"]).toBe("blocked");
    expect(AGENTD_STATUS_TO_UNIFIED["cancelled"]).toBe("cancelled");
  });

  it("工单派生任务带 related 工单句柄与 projectRef；非工单派生不带", async () => {
    const got = await collectAgentdTasks(() =>
      Promise.resolve([
        { id: "agt-1", status: "running", title: "#25 阈值配置化", sourceMessageId: "issue:org/repo#25" },
        { id: "agt-2", status: "needs_review", title: "手工任务", projectId: "timem_frontend" },
      ]),
    );
    expect(got).toHaveLength(2);
    expect(got[0].related?.["gitea-issue"]).toEqual({ guid: "org/repo#25" });
    expect(got[0].projectRef).toBe("org/repo");
    expect(got[0].status).toBe("running");
    expect(got[1].related).toBeUndefined();
    expect(got[1].projectRef).toBe("timem_frontend");
    expect(got[1].status).toBe("review");
  });

  it("issueHandleFromSource 只认 issue: 前缀", () => {
    expect(issueHandleFromSource("issue:org/repo#9")?.guid).toBe("org/repo#9");
    expect(issueHandleFromSource("feishu:guid-x")).toBeUndefined();
    expect(issueHandleFromSource(undefined)).toBeUndefined();
  });

  it("listTasks 抛错时静默返回空（错误由调用方 stats 兜底）", async () => {
    const got = await collectAgentdTasks(() => Promise.reject(new Error("socket gone")));
    expect(got).toEqual([]);
  });
});

// ── collectIntoRegistry 主干道 ───────────────────────────────────

function stubProvider(id: string, items: CollectTaskInput[], fail = false): TaskProvider {
  return {
    id,
    capabilities: { collect: true, execute: false },
    mapStatus: () => undefined,
    collect: function* () {
      if (fail) throw new Error(`${id} down`);
      yield* items;
    } as never,
  };
}

describe("collectIntoRegistry", () => {
  it("三源收集：发号/去重统计正确，related 跨源 JOIN 落到同一条记录", async () => {
    const registry = new TaskRegistry();
    const feishu = stubProvider("feishu-task", [
      { title: "[org/repo#25] 配置化", origin: { provider: "feishu-task", guid: "f-1" }, projectRef: "org/repo" },
    ]);
    const gitea = stubProvider("gitea-issue", [
      { title: "配置化", origin: { provider: "gitea-issue", guid: "org/repo#25" }, projectRef: "org/repo" },
    ]);
    const agentd = stubProvider("agentd-task", [
      {
        title: "#25 阈值配置化",
        origin: { provider: "agentd-task", guid: "agt-9" },
        projectRef: "org/repo",
        related: { "gitea-issue": { guid: "org/repo#25" } },
      },
    ]);

    const run1 = await collectIntoRegistry(registry, [feishu, gitea, agentd]);
    // 工单与 agentd 任务是同一真实工作项：gitea 先入册，agentd 经 related 并入同一条
    expect(run1.adoptedTotal).toBe(2);
    expect(run1.byProvider["feishu-task"]).toMatchObject({ scanned: 1, adopted: 1, existing: 0 });
    expect(run1.byProvider["gitea-issue"]).toMatchObject({ scanned: 1, adopted: 1, existing: 0 });
    expect(run1.byProvider["agentd-task"]).toMatchObject({ scanned: 1, adopted: 0, existing: 1 });

    // 同体收敛：工单句柄与 agentd 句柄落在同一条记录，双向可反查
    const issue = registry.findByExternal("gitea-issue", "org/repo#25")!;
    expect(registry.findByExternal("agentd-task", "agt-9")!.uid).toBe(issue.uid);
    expect(issue.links["gitea-issue"]?.guid).toBe("org/repo#25");
    expect(issue.links["agentd-task"]?.guid).toBe("agt-9");
    expect(issue.origin.provider).toBe("gitea-issue"); // 先入册者为主
    // 飞书侧标题前缀只是人读的，登记表层无硬关联 → 独立记录
    expect(registry.findByExternal("feishu-task", "f-1")!.uid).not.toBe(issue.uid);

    // 第二轮全量去重
    const run2 = await collectIntoRegistry(registry, [feishu, gitea, agentd]);
    expect(run2.adoptedTotal).toBe(0);
    expect(run2.existingTotal).toBe(3);
  });

  it("provider 抛错只记本源 errors，其余源照常收集", async () => {
    const registry = new TaskRegistry();
    const bad = stubProvider("agentd-task", [], true);
    const good = stubProvider("feishu-task", [{ title: "x", origin: { provider: "feishu-task", guid: "f-2" } }]);
    const run = await collectIntoRegistry(registry, [bad, good]);
    expect(run.byProvider["agentd-task"].errors).toHaveLength(1);
    expect(run.byProvider["feishu-task"].adopted).toBe(1);
  });

  it("无 guid 候选计 skipped", async () => {
    const registry = new TaskRegistry();
    const p = stubProvider("feishu-task", [
      { title: "无 guid", origin: { provider: "feishu-task", guid: "" } as never },
    ]);
    const run = await collectIntoRegistry(registry, [p]);
    expect(run.byProvider["feishu-task"].skipped).toBe(1);
    expect(registry.list()).toHaveLength(0);
  });
});

// ── 登记表 related 合并 ──────────────────────────────────────────

describe("TaskRegistry adopt 的 related 合并", () => {
  it("已存在记录只补缺失的 related 键，不覆盖已有句柄", () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "x", origin: { provider: "feishu-task", guid: "f-3" } });
    registry.link(r.uid, "agentd", { guid: "agt-old" });
    registry.adopt({
      title: "x（改题）",
      origin: { provider: "feishu-task", guid: "f-3" },
      related: { agentd: { guid: "agt-new" }, "gitea-issue": { guid: "org/repo#1" } },
    });
    expect(registry.get(r.uid)?.links["agentd"]?.guid).toBe("agt-old"); // 不覆盖
    expect(registry.get(r.uid)?.links["gitea-issue"]?.guid).toBe("org/repo#1"); // 补缺失
  });
});
