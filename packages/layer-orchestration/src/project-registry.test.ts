/**
 * project-registry 单测：群/仓库/名称解析 + 项目记忆键 + 组织清单
 */
import { describe, expect, it } from "vitest";
import {
  findProjectByChatId,
  findProjectByRepo,
  projectMemoryUserKey,
  projectRepoScope,
  registryOrgs,
  resolveProjectRef,
  type ProjectRegistryFile,
} from "./project-registry.js";

const FILE: ProjectRegistryFile = {
  version: 1,
  updated_at: "2026-09-30T00:00:00.000Z",
  projects: [
    {
      project_id: "nx",
      name: "NX 电信平台",
      aliases: ["nx", "电信"],
      gitea_repos: ["OrgA/nx-opc", "OrgA/nx-video"],
      feishu_chat_ids: ["oc_nx"],
    },
    {
      project_id: "timem",
      name: "TiMEM 平台",
      aliases: ["太忆"],
      gitea_repos: ["OrgB/timem-backend"],
      gitea_orgs: ["OrgB"],
      feishu_chat_ids: ["oc_timem"],
    },
  ],
};

describe("findProjectByChatId", () => {
  it("群 chatId → 项目；未登记返回 undefined", () => {
    expect(findProjectByChatId(FILE, "oc_nx")?.project_id).toBe("nx");
    expect(findProjectByChatId(FILE, "oc_none")).toBeUndefined();
  });
});

describe("findProjectByRepo", () => {
  it("直接命中 gitea_repos", () => {
    expect(findProjectByRepo(FILE, "OrgA/nx-opc")?.project_id).toBe("nx");
  });

  it("整组织项目按 org 段命中", () => {
    expect(findProjectByRepo(FILE, "OrgB/anything")?.project_id).toBe("timem");
  });

  it("未登记仓库返回 undefined", () => {
    expect(findProjectByRepo(FILE, "OrgC/other")).toBeUndefined();
  });
});

describe("resolveProjectRef", () => {
  it("id / 名称 / 别名精确命中", () => {
    expect(resolveProjectRef(FILE, "nx").project?.project_id).toBe("nx");
    expect(resolveProjectRef(FILE, "TiMEM 平台").project?.project_id).toBe("timem");
    expect(resolveProjectRef(FILE, "太忆").project?.project_id).toBe("timem");
  });

  it("大小写不敏感", () => {
    expect(resolveProjectRef(FILE, "NX").project?.project_id).toBe("nx");
  });

  it("查不到 / 空查询", () => {
    expect(resolveProjectRef(FILE, "不存在").project).toBeUndefined();
    expect(resolveProjectRef(FILE).project).toBeUndefined();
  });
});

describe("辅助", () => {
  it("projectMemoryUserKey = project:<id>", () => {
    expect(projectMemoryUserKey("nx")).toBe("project:nx");
  });

  it("projectRepoScope 返回仓库与组织", () => {
    const s = projectRepoScope(FILE.projects[1]!);
    expect(s.repos).toEqual(["OrgB/timem-backend"]);
    expect(s.orgs).toEqual(["OrgB"]);
  });

  it("registryOrgs 汇总去重（repo org 段 + gitea_orgs）", () => {
    expect(registryOrgs(FILE)).toEqual(["OrgA", "OrgB"]);
  });
});
