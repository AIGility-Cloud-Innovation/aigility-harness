/**
 * worker-team-boot 的 makeResolveCwd 单测：真源匹配（目录名≠仓库名）+ 无可匹配返回 undefined。
 * 2026-10-13：无默认仓库机制拍板 + resolver 升级——只靠短名试探会在目录名≠仓库名时
 * 解析失败→cwd 退回 task-loop 自身目录（工人在错误目录干活），必须返回 undefined 让派发报错。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeResolveCwd } from "./worker-team-boot.js";

describe("makeResolveCwd（真源匹配 + 无默认仓库）", () => {
  let root: string;
  let savedRoot: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "resolve-cwd-"));
    // 构造与真实工作区同构的布局：目录名≠仓库名（timem/TiMEM-Space）
    mkdirSync(join(root, "timem", "TiMEM-Space"), { recursive: true });
    mkdirSync(join(root, "nx-opc", "nx-telecom-opc-platform"), { recursive: true });
    mkdirSync(join(root, "timem-platform-backend"), { recursive: true });
    for (const [dir, url] of [
      [join(root, "timem", "TiMEM-Space"), "https://github.com/TiMEM-AI/TiMEM-Space.git"],
      [join(root, "nx-opc", "nx-telecom-opc-platform"), "ssh://git@git.aigility.cloud:1022/AIGility-Cloud-Innovation/nx-telecom-opc-platform.git"],
      [join(root, "timem-platform-backend"), "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend.git"],
    ] as const) {
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", url]);
    }
    savedRoot = process.env.WORKER_TEAM_REPO_ROOT;
    process.env.WORKER_TEAM_REPO_ROOT = root;
  });

  afterAll(() => {
    if (savedRoot === undefined) delete process.env.WORKER_TEAM_REPO_ROOT;
    else process.env.WORKER_TEAM_REPO_ROOT = savedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("目录名=短名直接命中", () => {
    const resolve = makeResolveCwd();
    expect(resolve("TiMEM-AI/timem-platform-backend")).toBe(join(root, "timem-platform-backend"));
  });

  it("目录名≠仓库名：按 git origin 真源匹配命中（timem/TiMEM-Space）", () => {
    const resolve = makeResolveCwd();
    expect(resolve("TiMEM-AI/TiMEM-Space")).toBe(join(root, "timem", "TiMEM-Space"));
  });

  it("同源双层目录命中（nx-opc/nx-telecom-opc-platform）", () => {
    const resolve = makeResolveCwd();
    expect(resolve("AIGility-Cloud-Innovation/nx-telecom-opc-platform")).toBe(join(root, "nx-opc", "nx-telecom-opc-platform"));
  });

  it("无匹配返回 undefined（不回落默认/错误目录）", () => {
    const resolve = makeResolveCwd();
    expect(resolve("TiMEM-AI/不存在的仓库")).toBeUndefined();
  });

  // 2026-10-25 现场事故：台账 projectRef 写成全小写 "TiMEM-AI/timem-space"，
  // 实际远端 "TiMEM-AI/TiMEM-Space"，原 endsWith 大小写敏感 → 解析失败 → 任务无 cwd。
  it("大小写不敏感：projectRef 全小写也命中 timem/TiMEM-Space", () => {
    const resolve = makeResolveCwd();
    expect(resolve("TiMEM-AI/timem-space")).toBe(join(root, "timem", "TiMEM-Space"));
  });

  it("`-` 与 `_` 等价：下划线写法命中连字符仓库", () => {
    const resolve = makeResolveCwd();
    expect(resolve("TiMEM-AI/timem_platform_backend")).toBe(join(root, "timem-platform-backend"));
  });

  it("短名直探同样忽略大小写与 `_`/`-` 差异", () => {
    const resolve = makeResolveCwd();
    expect(resolve("X/TIMEM_PLATFORM_BACKEND")).toBe(join(root, "timem-platform-backend"));
  });
});
