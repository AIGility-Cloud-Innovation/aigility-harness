import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRolePackage, loadRolePackages, validateRoleManifest } from "./index.js";

// 临时双层目录：公共层 + 站点层（站点覆盖公共的同 id）
const root = `/tmp/role-kit-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
const publicDir = join(root, "public");
const siteDir = join(root, "site", "roles");

function writePkg(dir: string, id: string, opts: { name: string; prompt: string; agentId?: string }) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "SKILL.md"), `---\nname: ${opts.name}\ndescription: 测试\n---\n\n${opts.prompt}`);
  writeFileSync(join(dir, id, "role.json"), JSON.stringify({
    role_id: id,
    identity: { name: opts.name },
    sources: {},
    actions: {},
    outbound: {},
    memory: { agent_id: opts.agentId ?? id },
  }));
}

// 公共层：guide + shared
writePkg(publicDir, "harness-guide", { name: "框架介绍员", prompt: "你是框架介绍员" });
writePkg(publicDir, "shared", { name: "公共版共享角色", prompt: "公共版" });
// 站点层：shared（站点定制覆盖公共）+ site-only
writePkg(siteDir, "shared", { name: "站点版共享角色", prompt: "站点版" });
writePkg(siteDir, "site-only", { name: "站点私有角色", prompt: "站点私有" });

describe("role-kit 角色包加载器", () => {
  it("双层解析：公共 + 站点全部可见，同 id 站点优先", () => {
    const pkgs = loadRolePackages({ publicDir, siteDirs: [siteDir] });
    const byId = Object.fromEntries(pkgs.map((p) => [p.id, p]));
    expect(pkgs).toHaveLength(3);
    expect(byId["harness-guide"].layer).toBe("public");
    expect(byId["shared"].layer).toBe("site");
    expect(byId["shared"].prompt).toContain("站点版");
    expect(byId["site-only"].layer).toBe("site");
  });

  it("单包加载：prompt 取 SKILL.md 正文，manifest 解析完整", () => {
    const p = loadRolePackage("harness-guide", { publicDir, siteDirs: [] });
    expect(p).not.toBeNull();
    expect(p!.name).toBe("框架介绍员");
    expect(p!.prompt).toContain("你是框架介绍员");
    expect(p!.manifest.memory.agent_id).toBe("harness-guide");
    expect(p!.manifest.identity.name).toBe("框架介绍员");
  });

  it("单包未命中 → null", () => {
    expect(loadRolePackage("no-such", { publicDir, siteDirs: [] })).toBeNull();
  });

  it("manifest 校验：agent_id ≠ role_id 判不合格", () => {
    const bad = {
      role_id: "r1",
      identity: { name: "x" },
      sources: {},
      actions: {},
      outbound: {},
      memory: { agent_id: "other" },
    };
    expect(validateRoleManifest(bad as never).length).toBe(1);
  });

  it("损坏的包不拖垮目录扫描", () => {
    const brokenDir = join(root, "broken");
    mkdirSync(join(brokenDir, "bad-pkg"), { recursive: true });
    writeFileSync(join(brokenDir, "bad-pkg", "SKILL.md"), "---\nname: 坏包\n---\n坏包");
    // 故意不写 role.json → 跳过
    const pkgs = loadRolePackages({ publicDir: brokenDir, siteDirs: [] });
    expect(pkgs).toHaveLength(0);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("role-kit 扩展字段与真实仓库角色", () => {
  it("commands/schedules/legacy_agent_ids 往返保留", () => {
    const dir = join(root, "ext");
    mkdirSync(join(dir, "pa"), { recursive: true });
    writeFileSync(join(dir, "pa", "SKILL.md"), "---\nname: 项目小助理\ndescription: 测试\n---\n正文");
    writeFileSync(join(dir, "pa", "role.json"), JSON.stringify({
      role_id: "pa",
      identity: { name: "项目小助理" },
      sources: {},
      actions: {
        commands: [{ pattern: "我的任务", action: "briefing:person" }],
        schedules: [{ name: "daily", trigger: "daily 18:30", action: "briefing:digest", enabled: false }],
      },
      outbound: {},
      memory: { agent_id: "pa", legacy_agent_ids: ["old-pa"] },
    }));
    const pkg = loadRolePackage("pa", { publicDir: dir, siteDirs: [] });
    expect(pkg?.manifest.actions.commands?.[0].action).toBe("briefing:person");
    expect(pkg?.manifest.actions.schedules?.[0].enabled).toBe(false);
    expect(pkg?.manifest.memory.legacy_agent_ids).toEqual(["old-pa"]);
    expect(validateRoleManifest(pkg!.manifest)).toHaveLength(0);
  });

  it("真实仓库 roles/：harness-guide 与 project-assistant 均可加载且校验通过", () => {
    const repoRoles = join(import.meta.dirname, "../../../roles");
    const pkgs = loadRolePackages({ publicDir: repoRoles, siteDirs: [] });
    const byId = Object.fromEntries(pkgs.map((p) => [p.id, p]));
    expect(byId["harness-guide"]).toBeTruthy();
    expect(byId["project-assistant"]).toBeTruthy();
    expect(byId["project-assistant"].name).toBe("项目小助理");
    expect(byId["project-assistant"].manifest.actions.commands?.length).toBeGreaterThan(10);
    expect(byId["project-assistant"].manifest.actions.schedules?.some((s) => s.enabled === false)).toBe(true);
    for (const p of pkgs) expect(validateRoleManifest(p.manifest)).toHaveLength(0);
  });
});
