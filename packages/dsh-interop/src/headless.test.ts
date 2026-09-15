import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHeadlessPatch, HEADLESS_MODEL_ROW_ID } from "./headless.js";

function makeHome(patchContent?: string): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-headless-"));
  const profileDir = join(home, "profiles", "headless");
  mkdirSync(profileDir, { recursive: true });
  if (patchContent !== undefined) {
    writeFileSync(join(profileDir, "cordis.patch.yml"), patchContent, "utf8");
  }
  return home;
}

function readPatch(home: string): string {
  return readFileSync(join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
}

describe("ensureHeadlessPatch — 用户补丁层按 id 合并", () => {
  it("空 home: 写入模型覆盖行", () => {
    const home = makeHome();
    ensureHeadlessPatch(home, "glm-4-flash");
    const yml = readPatch(home);
    expect(yml).toContain(`- id: ${HEADLESS_MODEL_ROW_ID}`);
    expect(yml).toContain("model: glm-4-flash");
  });

  it("外来行（persona-coach）原样保留，托管行按 id 替换", () => {
    const home = makeHome(
      [
        "# managed by @aigility-harness/dsh-interop (扁平 {id, config} 部分覆盖)",
        "- insert:",
        "    - id: persona-coach",
        "      name: '@aigility-harness/dsh-plugin-persona-coach'",
        `- id: ${HEADLESS_MODEL_ROW_ID}`,
        "  config:",
        "    provider: deepseek-official",
        "    model: glm-4-flash",
        "",
      ].join("\n"),
    );
    ensureHeadlessPatch(home, "glm-4.5");
    const yml = readPatch(home);
    expect(yml).toContain("id: persona-coach");
    expect(yml).toContain("name: '@aigility-harness/dsh-plugin-persona-coach'");
    expect(yml).toContain("model: glm-4.5");
    expect(yml).not.toContain("model: glm-4-flash");
    // 只有一个托管行（旧的被剔除）
    expect(yml.match(new RegExp(`id: ${HEADLESS_MODEL_ROW_ID}`, "g"))).toHaveLength(1);
  });

  it("幂等: 相同模型重复写入不改文件", () => {
    const home = makeHome();
    ensureHeadlessPatch(home, "glm-4-flash");
    const once = readPatch(home);
    ensureHeadlessPatch(home, "glm-4-flash");
    expect(readPatch(home)).toBe(once);
  });
});
