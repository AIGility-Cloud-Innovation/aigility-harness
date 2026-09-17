import { describe, it, expect } from "vitest";
import { installedDshPackages } from "./installed.js";

describe("installedDshPackages — 本机实际安装的官方 dsh 插件包", () => {
  const pkgs = installedDshPackages();
  const byName = new Map(pkgs.map((p) => [p.name, p]));

  it("递归展开后覆盖官方套件全家福（>40 个 @deepseek-ai 包，全部带版本）", () => {
    expect(pkgs.length).toBeGreaterThan(40);
    expect(pkgs.every((p) => p.name.startsWith("@deepseek-ai/"))).toBe(true);
    expect(pkgs.every((p) => /^\d/.test(p.version))).toBe(true);
  });

  it("传递依赖能力包在列且版本锁定一致", () => {
    // dsh-session 是 dsh-base 的传递依赖 —— 只看元包直接依赖会漏
    expect(byName.get("@deepseek-ai/dsh-session")?.version).toBe("0.1.5-rc.2");
    expect(byName.get("@deepseek-ai/dsh-mcp-client")).toBeTruthy();
    expect(byName.get("@deepseek-ai/dsh-terminal-bash")?.version).toBe("0.1.5-rc.2");
  });

  it("与官方清单对齐：session 是插件行；terminal-bash 复用旧包 tool-bash（清单行名仍指向旧包）", () => {
    expect(byName.get("@deepseek-ai/dsh-session")?.isPlugin).toBe(true);
    expect(byName.get("@deepseek-ai/dsh-session")?.officialRowIds).toContain("session");
    // 官方更名: terminal-bash 是对外包名, 内部依赖仍是 tool-bash;
    // 清单行 tool-bash 按包名精确匹配命中旧包 —— 两者共存于安装树
    expect(byName.has("@deepseek-ai/dsh-tool-bash")).toBe(true);
    expect(byName.get("@deepseek-ai/dsh-tool-bash")?.isPlugin).toBe(true);
    expect(byName.get("@deepseek-ai/dsh-terminal-bash")).toBeTruthy();
    expect(byName.get("@deepseek-ai/schemastery")?.isPlugin).toBe(false);
  });
});
