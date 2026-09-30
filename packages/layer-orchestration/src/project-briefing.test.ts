/**
 * project-briefing 纯函数单测：按人切片 / 渲染 / 快照文本 / log-monitor 解析
 * （网络采集不在此测；deps.fetchLogStatus 可注入，这里只测 parseLogStatus 经 collectLogs 注入路径）
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildMemberDigestText,
  buildProjectDigestText,
  collectLogs,
  issuesForUser,
  pullsForUser,
  renderPersonBrief,
  tasksForUser,
  type RepoSnapshot,
  type TaskLite,
} from "./project-briefing.js";
import { normalizeMember, type IdentityMember } from "./identity-registry.js";
import type { ProjectEntry } from "./project-registry.js";

const SNAPS: RepoSnapshot[] = [
  {
    repo: "OrgA/repo1",
    issues: [
      { repo: "OrgA/repo1", number: 1, title: "登录白屏", state: "open", assignees: ["zhangsan"] },
      { repo: "OrgA/repo1", number: 2, title: "导出失败", state: "open", assignees: ["lisi"], createdBy: "zhangsan" },
    ],
    pulls: [
      { repo: "OrgA/repo1", number: 10, title: "fix: 登录", user: "zhangsan", state: "open" },
      { repo: "OrgA/repo1", number: 11, title: "chore", user: "lisi", state: "open" },
    ],
  },
  { repo: "OrgB/repo2", issues: [], pulls: [], error: "HTTP 500" },
];

describe("issuesForUser / pullsForUser", () => {
  it("执行人切 assigned，提出人切 created（大小写不敏感）", () => {
    const r = issuesForUser(SNAPS, ["ZhangSan"]);
    expect(r.assigned.map((i) => i.number)).toEqual([1]);
    expect(r.created.map((i) => i.number)).toEqual([2]);
  });

  it("PR 按作者过滤", () => {
    expect(pullsForUser(SNAPS, ["zhangsan"]).map((p) => p.number)).toEqual([10]);
  });
});

describe("tasksForUser", () => {
  const tasks: TaskLite[] = [
    { summary: "[OrgA/repo1#3] 修登录", description: "来源群 oc_1\n执行者：张三", section: "D 执行中", org: "OrgA" },
    { summary: "优化导出", description: "执行者:li si", section: "P 计划中", org: "OrgA" },
    { summary: "整理会议纪要", description: "", section: "P 计划中", org: "OrgA" },
  ];

  it("描述含「执行者：<姓名/别名>」或标题含姓名即命中", () => {
    const r = tasksForUser(tasks, ["张三"]);
    expect(r.map((t) => t.summary)).toEqual(["[OrgA/repo1#3] 修登录"]);
  });
});

describe("renderPersonBrief", () => {
  it("未登记成员给出登记引导，绝不用 anonymous", () => {
    const text = renderPersonBrief({
      now: new Date("2026-09-30T10:00:00+08:00"),
      fallbackUserId: "ou_abc",
      assigned: [],
      created: [],
      pulls: [],
      tasks: [],
      memories: [],
      sourcesOk: ["gitea"],
      sourcesFailed: [],
    });
    expect(text).toContain("ou_abc");
    expect(text).toContain("身份对齐");
    expect(text).not.toContain("anonymous");
  });

  it("登记成员渲染工单/PR/任务分区", () => {
    const m: IdentityMember = normalizeMember({ member_id: "m1", name: "张三", aliases: [], timem_user_ids: ["space_1"], feishu_open_ids: [], gitea_usernames: ["zhangsan"] });
    const text = renderPersonBrief({
      now: new Date("2026-09-30T10:00:00+08:00"),
      member: m,
      assigned: SNAPS[0]!.issues.slice(0, 1),
      created: [],
      pulls: SNAPS[0]!.pulls.slice(0, 1),
      tasks: [{ summary: "修登录", section: "D 执行中" }],
      memories: ["之前讨论过登录页重构"],
      sourcesOk: ["gitea", "feishu", "timem"],
      sourcesFailed: ["OrgB/repo2 issues: HTTP 500"],
    });
    expect(text).toContain("张三");
    expect(text).toContain("待办工单");
    expect(text).toContain("open PR");
    expect(text).toContain("飞书任务");
    expect(text).toContain("相关记忆");
    expect(text).toContain("HTTP 500");
  });
});

describe("buildProjectDigestText / buildMemberDigestText", () => {
  const project: ProjectEntry = { project_id: "timem", name: "TiMEM 平台", gitea_repos: ["OrgA/repo1"], log_sources: [] };

  it("项目快照含计数与触发说明", () => {
    const t = buildProjectDigestText({
      now: new Date("2026-09-30T18:30:00+08:00"),
      project,
      snaps: SNAPS,
      tasks: [{ summary: "x", section: "D 执行中" }, { summary: "y", section: "P 计划中" }],
      logs: [{ p: "timem-space_main", s: "app", lastErr: "boom", errs: [] }],
      trigger: "daily",
    });
    expect(t).toContain("【项目快照·每日】");
    expect(t).toContain("工单: open 2");
    expect(t).toContain("日志异常");
  });

  it("个人快照：无在办时写明空", () => {
    const m: IdentityMember = normalizeMember({ member_id: "m1", name: "张三", aliases: [], timem_user_ids: [], feishu_open_ids: [], gitea_usernames: [] });
    const empty = buildMemberDigestText({ now: new Date(), member: m, assigned: [], created: [], pulls: [], tasks: [], trigger: "event" });
    expect(empty).toContain("无进行中");
    const full = buildMemberDigestText({
      now: new Date(), member: m,
      assigned: SNAPS[0]!.issues.slice(0, 1), created: [], pulls: SNAPS[0]!.pulls.slice(0, 1), tasks: [],
      trigger: "daily",
    });
    expect(full).toContain("待办工单 1");
  });
});

describe("collectLogs（注入 fetch）", () => {
  it("按 p/s 过滤 lastErr 与 errs；失败记 errors", async () => {
    const fetchLogStatus = vi.fn().mockResolvedValue({
      autos: [{ p: "timem-space_main", s: "app", lastErr: "boom" }, { p: "other", s: "x", lastErr: "noisy" }],
      errs: [
        { t: 1, src: "timem-space_main / app", line: "E1" },
        { t: 2, src: "other / x", line: "E2" },
      ],
    });
    const { logs, errors } = await collectLogs(
      [{ host: "http://127.0.0.1:1", p: "timem-space_main", s: "app" }],
      { fetchLogStatus },
    );
    expect(errors).toEqual([]);
    expect(logs[0]!.lastErr).toBe("boom");
    expect(logs[0]!.errs.map((e) => e.line)).toEqual(["E1"]);
  });
});
