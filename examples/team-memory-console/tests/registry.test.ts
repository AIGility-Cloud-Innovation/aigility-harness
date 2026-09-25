import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamRegistry } from "../src/registry.js";

function makeRegistry(members: unknown[] = []) {
  const path = join(mkdtempSync(join(tmpdir(), "tmreg-")), "registry.json");
  writeFileSync(path, JSON.stringify({ version: 1, updated_at: "", members }), "utf8");
  return new TeamRegistry(path);
}

const seed = [
  { member_id: "zhang-san", name: "张三", aliases: ["san", "zs"], timem_user_ids: ["101", "u-abc"] },
  { member_id: "li-si", name: "李四", aliases: ["lsi"], timem_user_ids: [] },
  { member_id: "wang-wu", name: "王五", aliases: ["张先生"], timem_user_ids: ["102"] },
];

describe("TeamRegistry 解析", () => {
  it("精确匹配: 姓名 / member_id / 别名", () => {
    const reg = makeRegistry(seed);
    expect(reg.resolve("张三")).toMatchObject({ kind: "exact" });
    expect(reg.resolve("zhang-san")).toMatchObject({ kind: "exact" });
    expect(reg.resolve("san")).toMatchObject({ kind: "exact" });
    expect((reg.resolve("zs") as { member: { name: string } }).member.name).toBe("张三");
  });

  it("大小写与空白不敏感", () => {
    const reg = makeRegistry([{ member_id: "a", name: "Alice", aliases: [], timem_user_ids: [] }]);
    expect(reg.resolve("  alice ")).toMatchObject({ kind: "exact" });
  });

  it("模糊: 唯一包含命中即 exact; 多人命中返回 ambiguous 候选", () => {
    const reg = makeRegistry(seed);
    expect((reg.resolve("张三") as { member: { name: string } }).member.name).toBe("张三");
    // "张" 同时包含命中 张三 / 张先生(别名) → ambiguous
    const amb = reg.resolve("张");
    expect(amb.kind).toBe("ambiguous");
    if (amb.kind === "ambiguous") expect(amb.candidates.map((c) => c.name).sort()).toEqual(["张三", "王五"]);
  });

  it("模糊: 多人命中返回 ambiguous 候选", () => {
    const reg = makeRegistry(seed);
    const r = reg.resolve("张先生");
    expect(r.kind).toBe("exact"); // 别名精确优先
    const r2 = reg.resolve("李");
    expect(r2.kind).toBe("exact");
    const dup = makeRegistry([
      { member_id: "x1", name: "小明", aliases: [], timem_user_ids: [] },
      { member_id: "x2", name: "小红", aliases: ["小明哥"], timem_user_ids: [] },
    ]);
    expect((dup.resolve("小明哥") as { kind: string }).kind).toBe("exact");
  });

  it("未命中", () => {
    const reg = makeRegistry(seed);
    expect(reg.resolve("赵六").kind).toBe("none");
  });
});

describe("TeamRegistry 绑定", () => {
  it("user_id 反查归属", () => {
    const reg = makeRegistry(seed);
    expect(reg.findByUserId("101")?.member_id).toBe("zhang-san");
    expect(reg.findByUserId("u-abc")?.name).toBe("张三");
    expect(reg.findByUserId("999")).toBeUndefined();
    expect(reg.isKnownUserId("102")).toBe(true);
  });

  it("bind 幂等", () => {
    const reg = makeRegistry(seed);
    reg.bind("zhang-san", "101");
    expect(reg.mustGet("zhang-san").timem_user_ids).toEqual(["101", "u-abc"]);
    reg.bind("zhang-san", 300); // 数字自动转字符串
    expect(reg.mustGet("zhang-san").timem_user_ids).toContain("300");
  });

  it("user_id 被他人绑定时 bind 抛错 (防串号)", () => {
    const reg = makeRegistry(seed);
    expect(() => reg.bind("li-si", "102")).toThrow(/已绑定给 王五/);
  });

  it("unbind / remove / unknown 观察", () => {
    const reg = makeRegistry(seed);
    reg.unbind("zhang-san", "101");
    expect(reg.mustGet("zhang-san").timem_user_ids).toEqual(["u-abc"]);
    expect(reg.allUserIds()).toEqual(["u-abc", "102"]);
    reg.observeUnknown("777");
    reg.observeUnknown("777");
    expect(reg.unknownUserIds).toEqual([["777", 2]]);
    expect(reg.remove("li-si")).toBe(true);
    expect(reg.resolve("李四").kind).toBe("none");
  });
});
