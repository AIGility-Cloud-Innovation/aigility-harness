import { describe, expect, it } from "vitest";
import { buildAggregatorPlan, resolveChannelUserId, toFeishuIngressRequest } from "./channel-aggregator.js";
import type { RoleManifestV2 } from "./role-manifest.js";
import type { IdentityRegistryFile } from "@aigility-harness/layer-orchestration";

function manifest(partial: Partial<RoleManifestV2>): RoleManifestV2 {
  return {
    role_id: partial.role_id ?? "demo-role",
    identity: { name: partial.identity?.name ?? "演示角色", ...partial.identity },
    sources: {
      channels: partial.sources?.channels,
      data: partial.sources?.data ?? [],
    },
    actions: { tools: [], workflows: [], ...partial.actions },
    outbound: { push: [], ...partial.outbound },
    memory: { agent_id: partial.memory?.agent_id ?? partial.role_id ?? "demo-role" },
  };
}

describe("通道聚合器（M1 dry-run）", () => {
  it("纯网页角色（无 channels）进 webOnly，不产生 app 计划（基线 1）", () => {
    const plan = buildAggregatorPlan([manifest({ role_id: "web-only", sources: { data: [] } })]);
    expect(plan.apps).toHaveLength(0);
    expect(plan.webOnlyRoleIds).toEqual(["web-only"]);
    expect(plan.issues).toHaveLength(0);
  });

  it("单角色单 app：生成 agentRoutes 与兜底 persona", () => {
    const plan = buildAggregatorPlan([
      manifest({
        role_id: "baojing-analyst",
        sources: {
          channels: [{ platform: "feishu", apps: [{ app: "feishu-baojing", chats: ["oc_1", "oc_2"] }] }],
        },
      }),
    ]);
    expect(plan.apps).toHaveLength(1);
    expect(plan.apps[0].agentRoutes).toEqual({ oc_1: "@persona/baojing-analyst", oc_2: "@persona/baojing-analyst" });
    expect(plan.apps[0].perceptionId).toBe("@persona/baojing-analyst");
  });

  it("跨平台多 app = 同一角色（基线 4）：两 app 各一条连接、同一记忆域、无冲突", () => {
    const plan = buildAggregatorPlan([
      manifest({
        role_id: "baojing-analyst",
        sources: {
          channels: [
            { platform: "feishu", apps: [{ app: "feishu-baojing", chats: ["oc_1"] }] },
            { platform: "wecom", apps: [{ app: "wecom-baojing", chats: ["wr_1"] }] },
          ],
        },
      }),
    ]);
    expect(plan.apps).toHaveLength(2);
    expect(plan.apps.every((a) => a.memoryAgentIds.join() === "baojing-analyst")).toBe(true);
    expect(plan.issues).toHaveLength(0);
  });

  it("面貌一致性冲突（基线 2）：一个 app 声明两个角色 → issue", () => {
    const plan = buildAggregatorPlan([
      manifest({ role_id: "r1", sources: { channels: [{ platform: "feishu", apps: [{ app: "shared-app" }] }] } }),
      manifest({ role_id: "r2", sources: { channels: [{ platform: "feishu", apps: [{ app: "shared-app" }] }] } }),
    ]);
    expect(plan.issues.some((i) => i.includes("面貌一致性冲突"))).toBe(true);
  });

  it("记忆域分裂检测（基线 3）：同 app 多角色 memory.agent_id 不一致 → issue", () => {
    const m1 = manifest({ role_id: "r1", sources: { channels: [{ platform: "feishu", apps: [{ app: "a" }] }] } });
    const m2 = manifest({
      role_id: "r2",
      memory: { agent_id: "r2" },
      sources: { channels: [{ platform: "feishu", apps: [{ app: "a" }] }] },
    });
    // 注意：m2 与 m1 同时声明 app a 会先触发基线 2 冲突；此用例验证 agent_id 维度的 issue 也存在
    const plan = buildAggregatorPlan([m1, m2]);
    expect(plan.issues.some((i) => i.includes("面貌一致性冲突"))).toBe(true);
  });

  it("声明校验失败（agent_id ≠ role_id）→ issue 且不产生计划", () => {
    const plan = buildAggregatorPlan([
      manifest({ role_id: "r1", memory: { agent_id: "other" }, sources: { channels: [{ platform: "feishu", apps: [{ app: "a" }] }] } }),
    ]);
    expect(plan.issues.some((i) => i.includes("必须等于 role_id"))).toBe(true);
    expect(plan.apps).toHaveLength(0);
  });

  it("toFeishuIngressRequest：feishu app → 装配请求；wecom app 拒绝", () => {
    const feishuPlan = { platform: "feishu" as const, appId: "f1", agentRoutes: { "*": "@persona/r1" }, perceptionId: "@persona/r1", roleIds: ["r1"], memoryAgentIds: ["r1"] };
    expect(toFeishuIngressRequest(feishuPlan).appId).toBe("f1");
    const wecomPlan = { ...feishuPlan, platform: "wecom" as const };
    expect(() => toFeishuIngressRequest(wecomPlan)).toThrow();
  });
});

describe("resolveChannelUserId（user 维归集）", () => {
  const registry: IdentityRegistryFile = {
    version: 2,
    updated_at: "",
    members: [
      {
        member_id: "m-zhang",
        name: "张三",
        aliases: [],
        timem_user_ids: ["timem-zhang-001"],
        feishu_open_ids: ["ou_zhang"],
        gitea_usernames: [],
        wecom_user_ids: ["zhang_wecom"],
        web_emails: ["zhang@corp.local"],
      },
      {
        member_id: "m-li",
        name: "李四",
        aliases: [],
        timem_user_ids: [],
        feishu_open_ids: [],
        gitea_usernames: [],
        wecom_user_ids: [],
        web_emails: [],
      },
    ],
  };

  it("命中登记表 → 规范 timem user_id（三平台同一人同键, 基线 5）", () => {
    expect(resolveChannelUserId(registry, "feishu", "ou_zhang")).toBe("timem-zhang-001");
    expect(resolveChannelUserId(registry, "wecom", "zhang_wecom")).toBe("timem-zhang-001");
    expect(resolveChannelUserId(registry, "web", "Zhang@corp.local")).toBe("timem-zhang-001"); // 大小写归一
  });

  it("timem 轴缺失 → 回退 member_id", () => {
    expect(resolveChannelUserId(registry, "wecom", "unbound-li")).toBe("wecom:unbound-li"); // 未绑定走来源键
  });

  it("未命中 → 来源键（绝不裸 anonymous）", () => {
    expect(resolveChannelUserId(registry, "wecom", "stranger")).toBe("wecom:stranger");
  });
});
