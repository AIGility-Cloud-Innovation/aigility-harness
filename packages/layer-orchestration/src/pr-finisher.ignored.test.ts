/**
 * filterIgnored 回归测试（2026-10-25 事故）：
 * .backups/ 被 .gitignore 忽略时，交付前必须剔除，否则 git add 致命失败。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { filterIgnored } from "./pr-finisher.js";

function repoWith(ignore: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fi-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), ignore);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".backups", "snap-1"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".backups", "snap-1", "index.html"), "<html></html>\n");
  return dir;
}

describe("filterIgnored", () => {
  it("剔除 .gitignore 覆盖的 .backups 路径，保留真实改动", async () => {
    const dir = repoWith(".backups/\n");
    const kept = await filterIgnored(["src/a.ts", ".backups/snap-1/index.html"], dir);
    expect(kept).toEqual(["src/a.ts"]);
  });

  it("没有忽略规则时原样返回", async () => {
    const dir = repoWith("# 空\n");
    const files = ["src/a.ts", ".backups/snap-1/index.html"];
    expect(await filterIgnored(files, dir)).toEqual(files);
  });

  it("全部被忽略时返回空数组（调用方据此报「无可交付文件」）", async () => {
    const dir = repoWith(".backups/\n");
    expect(await filterIgnored([".backups/snap-1/index.html"], dir)).toEqual([]);
  });

  it("空列表直接返回空", async () => {
    expect(await filterIgnored([], "/tmp")).toEqual([]);
  });
});
