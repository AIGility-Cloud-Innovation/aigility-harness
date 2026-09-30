/**
 * briefing-events 单测：仓库→项目归属、事件节流（10 分钟窗口内只触发一次）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_THROTTLE_MS,
  notifyRepoActivity,
  resetBriefingActivityForTest,
  setBriefingActivitySink,
} from "./briefing-events.js";

function fixtureRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), "briefing-events-"));
  const path = join(dir, "project-registry.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      updated_at: "2026-09-30T00:00:00.000Z",
      projects: [
        { project_id: "nx", name: "NX", gitea_repos: ["OrgA/nx-opc"], feishu_chat_ids: [] },
        { project_id: "orgwide", name: "全景", gitea_orgs: ["OrgB"], feishu_chat_ids: [] },
      ],
    }),
    "utf8",
  );
  return path;
}

let sinkCalls: Array<{ project: string; hint: string }>;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.PROJECT_REGISTRY_PATH = fixtureRegistry();
  sinkCalls = [];
  setBriefingActivitySink((project, hint) => sinkCalls.push({ project, hint }));
});

afterEach(() => {
  resetBriefingActivityForTest();
  delete process.env.PROJECT_REGISTRY_PATH;
  vi.useRealTimers();
});

describe("notifyRepoActivity", () => {
  it("已登记仓库归属项目键", () => {
    notifyRepoActivity("OrgA/nx-opc", "新建工单 #1");
    expect(sinkCalls).toEqual([{ project: "nx", hint: "新建工单 #1" }]);
  });

  it("整组织项目的仓库按 org 段归属", () => {
    notifyRepoActivity("OrgB/anything", "PR 合并");
    expect(sinkCalls[0]!.project).toBe("orgwide");
  });

  it("未登记仓库回退 org:<组织> 键", () => {
    notifyRepoActivity("OrgC/other", "x");
    expect(sinkCalls[0]!.project).toBe("org:OrgC");
  });

  it("同一项目 10 分钟窗口内只触发一次；窗口过后可再触发", () => {
    notifyRepoActivity("OrgA/nx-opc", "第一次");
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS - 1000);
    notifyRepoActivity("OrgA/nx-opc", "窗口内的第二次");
    expect(sinkCalls).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    notifyRepoActivity("OrgA/nx-opc", "窗口后的第三次");
    expect(sinkCalls).toHaveLength(2);
    expect(sinkCalls[1]!.hint).toBe("窗口后的第三次");
  });
});
