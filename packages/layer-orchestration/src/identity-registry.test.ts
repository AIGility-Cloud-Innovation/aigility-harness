/**
 * identity-registry 单测：三轴解析 / 规范 timem id / 绑定与冲突 / 自动匹配打分
 */
import { describe, expect, it } from "vitest";
import {
  axisIds,
  bindIdentityAxis,
  canonicalTimemUserId,
  findMemberByFeishuOpenId,
  findMemberByGiteaUsername,
  findMemberByTimemUserId,
  normalizeMember,
  resolveMemberByName,
  scoreIdentityCandidates,
  unbindIdentityAxis,
  type IdentityMember,
  type IdentityRegistryFile,
} from "./identity-registry.js";

function member(over: Partial<IdentityMember>): IdentityMember {
  return normalizeMember({ member_id: "m1", name: "张三", ...over });
}

function file(members: IdentityMember[]): IdentityRegistryFile {
  return { version: 2, updated_at: "2026-09-30T00:00:00.000Z", members };
}

describe("normalizeMember", () => {
  it("老版本条目缺新字段时补默认值", () => {
    const m = normalizeMember({ member_id: "x", name: "X", aliases: ["x"], timem_user_ids: ["space_1"] });
    expect(m.feishu_open_ids).toEqual([]);
    expect(m.gitea_usernames).toEqual([]);
    expect(m.match_source).toEqual({});
  });

  it("gitea 用户名归一为小写", () => {
    const m = normalizeMember({ member_id: "x", name: "X", aliases: [], timem_user_ids: [], gitea_usernames: ["Johnny"] });
    expect(m.gitea_usernames).toEqual(["johnny"]);
  });
});

describe("三轴反向解析", () => {
  const f = file([
    member({ member_id: "m1", name: "张三", aliases: ["san"], feishu_open_ids: ["ou_a"], gitea_usernames: ["zhangsan"], timem_user_ids: ["space_1"] }),
    member({ member_id: "m2", name: "李四", aliases: [], feishu_open_ids: ["ou_b"], gitea_usernames: ["lisi"], timem_user_ids: [] }),
  ]);

  it("飞书 open_id → 成员", () => {
    expect(findMemberByFeishuOpenId(f, "ou_a")?.member_id).toBe("m1");
    expect(findMemberByFeishuOpenId(f, "ou_z")).toBeUndefined();
  });

  it("Gitea 用户名大小写不敏感", () => {
    expect(findMemberByGiteaUsername(f, "ZhangSan")?.member_id).toBe("m1");
  });

  it("timem user_id → 成员", () => {
    expect(findMemberByTimemUserId(f, "space_1")?.member_id).toBe("m1");
  });

  it("规范 timem id：优先 space id，缺失回退 member_id", () => {
    expect(canonicalTimemUserId(f.members[0]!)).toBe("space_1");
    expect(canonicalTimemUserId(f.members[1]!)).toBe("m2");
  });
});

describe("resolveMemberByName", () => {
  const f = file([
    member({ member_id: "m1", name: "张三", aliases: ["san"] }),
    member({ member_id: "m2", name: "李四", aliases: ["李四四"] }),
  ]);

  it("精确：member_id / 姓名 / 别名", () => {
    expect(resolveMemberByName(f, "m1").kind).toBe("exact");
    expect(resolveMemberByName(f, "张三").kind).toBe("exact");
    expect(resolveMemberByName(f, "san").kind).toBe("exact");
  });

  it("模糊唯一命中", () => {
    expect(resolveMemberByName(f, "张").kind).toBe("exact");
    const r = resolveMemberByName(f, "李四四");
    expect(r.kind).toBe("exact");
  });

  it("查无此人", () => {
    expect(resolveMemberByName(f, "王五").kind).toBe("none");
  });
});

describe("bindIdentityAxis / unbindIdentityAxis", () => {
  it("绑定幂等，同轴同 id 绑他人报错（防串号）", () => {
    const f = file([
      member({ member_id: "m1", name: "张三" }),
      member({ member_id: "m2", name: "李四" }),
    ]);
    bindIdentityAxis(f, "m1", "feishu", "ou_x", "manual");
    bindIdentityAxis(f, "m1", "feishu", "ou_x", "manual"); // 幂等
    expect(axisIds(f.members[0]!, "feishu")).toEqual(["ou_x"]);
    expect(() => bindIdentityAxis(f, "m2", "feishu", "ou_x", "manual")).toThrow(/已绑定/);
  });

  it("manual 标记不被 auto 覆盖，auto 可被 manual 覆盖", () => {
    const f = file([member({ member_id: "m1", name: "张三" })]);
    bindIdentityAxis(f, "m1", "gitea", "zs", "auto");
    expect(f.members[0]!.match_source?.gitea).toBe("auto");
    bindIdentityAxis(f, "m1", "gitea", "zs", "manual");
    expect(f.members[0]!.match_source?.gitea).toBe("manual");
  });

  it("gitea 绑定归一小写", () => {
    const f = file([member({ member_id: "m1", name: "张三" })]);
    bindIdentityAxis(f, "m1", "gitea", "ZhangSan", "auto");
    expect(f.members[0]!.gitea_usernames).toEqual(["zhangsan"]);
  });

  it("解绑最后一条身份后清除来源标记", () => {
    const f = file([member({ member_id: "m1", name: "张三" })]);
    bindIdentityAxis(f, "m1", "timem", "space_9", "auto");
    unbindIdentityAxis(f, "m1", "timem", "space_9");
    expect(f.members[0]!.timem_user_ids).toEqual([]);
    expect(f.members[0]!.match_source?.timem).toBeUndefined();
  });
});

describe("scoreIdentityCandidates", () => {
  const m = member({ member_id: "m1", name: "johnny", aliases: ["主账号", "老板"] });

  it("完全一致 100 分", () => {
    const r = scoreIdentityCandidates(m, [{ id: "other", name: "Johnny" }]);
    expect(r[0]!.score).toBe(100);
  });

  it("互相包含 ≥3 字符 70 分", () => {
    const r = scoreIdentityCandidates(m, [{ id: "johnny-dev", name: "johnny-dev" }]);
    expect(r[0]!.score).toBe(70);
  });

  it("别名包含显示名 70 分", () => {
    const r = scoreIdentityCandidates(m, [{ id: "u123", name: "主账号运维" }]);
    expect(r[0]!.score).toBe(70);
  });

  it("无关候选不上榜", () => {
    expect(scoreIdentityCandidates(m, [{ id: "wangwu", name: "王五" }])).toEqual([]);
  });
});
