/**
 * Gitea PR 集成测试（2026-10-12 需求：每个项目的 PR 作为日报成果证据）
 *
 * 覆盖：
 *  - renderCompactDaily：merged/open PR → 按项目 done/doing 行 + 按人 PR 行（gitea_usernames 归属）
 *  - fetchRecentPrs 窗口口径（经 buildCompactDailyReport + mock fetch）：
 *    merged 按 merged_at（北京时间）判当日——「几天前合并、今天被评论」不得再报为今日成果
 *  - renderDailyBriefing：【PR 动态】行——短仓名 + 中文显示名 + 已合并/在途口径
 *
 * Gitea 网络一律 mock（单测不外联）；成员/项目归属读真实 registry（与线上同源）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  renderCompactDaily,
  renderDailyBriefing,
  buildCompactDailyReport,
} from "../src/task-cards.js";

type AnyPr = Record<string, unknown>;
type AnyTask = Record<string, unknown>;

const DATE = "2026-10-12";

/** 构造 PrItem 形状的夹具 */
function pr(over: AnyPr): AnyPr {
  return {
    repo: "TiMEM-AI/timem-platform-backend",
    number: 201,
    title: "fix: 中转流式 usage 防御",
    state: "closed",
    merged: true,
    author: "jihanyun",
    updatedAt: `${DATE}T10:00:00+08:00`,
    ...over,
  };
}

function task(over: AnyTask): AnyTask {
  return {
    uid: "t1",
    title: "【TiMEM】SSE 修复",
    status: "done",
    projectRef: "TiMEM-AI/timem-platform-backend",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderCompactDaily — 按项目 PR 汇总", () => {
  it("merged PR 进 done 行（合并 PR N 个）", () => {
    const text = renderCompactDaily(DATE, [task({})] as never, [pr({})] as never, []);
    expect(text).toContain("- TiMEM 平台：");
    expect(text).toContain("合并 PR 1 个");
  });

  it("只有 PR 没有台账任务的项目也会出现", () => {
    const text = renderCompactDaily(DATE, [] as never, [pr({})] as never, []);
    expect(text).toContain("- TiMEM 平台：");
    expect(text).toContain("合并 PR 1 个");
  });

  it("open PR 只进 doing 行（在途 PR N 个），不进 done", () => {
    const text = renderCompactDaily(
      DATE,
      [] as never,
      [pr({ merged: false, state: "open", updatedAt: `${DATE}T09:00:00+08:00` })] as never,
      [],
    );
    expect(text).not.toContain("合并 PR");
    expect(text).toContain("在途 PR 1 个");
  });

  it("merged+open 混合：done 报合并数，doing 报在途数", () => {
    const text = renderCompactDaily(
      DATE,
      [] as never,
      [
        pr({ number: 201 }),
        pr({ number: 202, merged: false, state: "open" }),
        pr({ number: 203, merged: false, state: "open" }),
      ] as never,
      [],
    );
    expect(text).toContain("合并 PR 1 个");
    expect(text).toContain("在途 PR 2 个");
  });

  it("org 展开仓不在项目映射时回退短仓名", () => {
    const text = renderCompactDaily(
      DATE,
      [] as never,
      [pr({ repo: "TiMEM-AI/dsh-plugin-timem", number: 9 })] as never,
      [],
    );
    expect(text).toContain("- dsh-plugin-timem：");
  });
});

describe("renderCompactDaily — 按人 PR 归属（registry gitea_usernames）", () => {
  it("author 命中绑定账号 → 出现在该成员名下（合并 N/在途 N + PR 摘要）", () => {
    // jihanyun → member-johnny（registry 绑定，显示名取首个中文别名）
    const text = renderCompactDaily(
      DATE,
      [] as never,
      [
        pr({ number: 201 }),
        pr({ number: 202, merged: false, state: "open" }),
      ] as never,
      [],
    );
    expect(text).toContain("- 吉翰云：");
    expect(text).toContain("PR：合并 1/在途 1");
    expect(text).toContain("timem-platform-backend#201");
  });

  it("外部作者（未绑定账号）不产生按人段", () => {
    const text = renderCompactDaily(
      DATE,
      [] as never,
      [pr({ author: "outsider-dev" })] as never,
      [],
    );
    expect(text).toContain("- TiMEM 平台："); // 项目行仍在
    expect(text).not.toContain("outsider-dev");
    expect(text).toContain("（今日无人员动态）");
  });
});

describe("fetchRecentPrs 窗口口径 — merged 按 merged_at 判当日", () => {
  it("几天前合并、今天被评论的 PR 不再报为今日成果；当日 merged 与在途 open 正常进", async () => {
    const ok = (data: unknown) => ({ ok: true, json: async () => data }) as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/orgs/")) {
          return ok([
            { full_name: "TiMEM-AI/timem-platform-backend" },
            { full_name: "TiMEM-AI/dsh-plugin-timem" },
          ]);
        }
        if (u.includes("/pulls")) {
          if (u.includes("TiMEM-AI/timem-platform-backend")) {
            return ok([
              { number: 201, state: "closed", merged: true, merged_at: `${DATE}T10:00:00+08:00`, updated_at: `${DATE}T10:00:00+08:00`, user: { login: "jihanyun" } },
              // 关键回归：3 天前合并、今天被评论 → 不得算今日成果
              { number: 202, state: "closed", merged: true, merged_at: "2026-10-09T10:00:00+08:00", updated_at: `${DATE}T09:00:00+08:00`, user: { login: "jihanyun" } },
              // 在途：今天有动态
              { number: 203, state: "open", merged: false, updated_at: `${DATE}T08:00:00+08:00`, user: { login: "liuxiao" } },
            ]);
          }
          return ok([]);
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const text = await buildCompactDailyReport(DATE, []);
    expect(text).toContain("timem-platform-backend#201"); // 当日 merged 进
    expect(text).not.toContain("#202"); // 旧 merged 被窗口排除
    expect(text).toContain("timem-platform-backend#203"); // 在途进
  });
});

describe("renderDailyBriefing — 【PR 动态】段", () => {
  it("短仓名 + 中文显示名 + 已合并/在途口径", () => {
    const text = renderDailyBriefing(
      [] as never,
      [
        pr({ number: 201 }),
        pr({ number: 203, merged: false, state: "open", author: "liuxiao" }),
        pr({ number: 205, repo: "TiMEM-AI/dsh-plugin-timem", author: "outsider-dev" }),
      ] as never,
      [],
    );
    expect(text).toContain("【PR 动态】");
    expect(text).toContain("已合并=成果证据；在途=进行中预告");
    expect(text).toContain("- TiMEM 平台 #201");
    expect(text).toContain("（吉翰云，已合并）");
    expect(text).toContain("（刘晓，在途）");
    expect(text).toContain("dsh-plugin-timem #205"); // 未登记项目 → 短仓名
    expect(text).toContain("（outsider-dev，已合并）"); // 未登记作者 → 原样
  });
});
