import { describe, it, expect } from "vitest";
import { dshBaseRows, isJsExpr } from "./base-rows.js";

describe("dshBaseRows — 官方 dsh-base 行清单解析", () => {
  const rows = dshBaseRows();
  const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id!, r]));

  it("解析出完整官方清单（约 60 行）", () => {
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => typeof r.name === "string" && r.name.length > 0)).toBe(true);
  });

  it("已知行存在且包名正确", () => {
    expect(byId.get("timer")?.name).toBe("@deepseek-ai/cordis-plugin-timer");
    expect(byId.get("llm")?.name).toBe("@deepseek-ai/dsh-llm");
    expect(byId.get("agent-loop")?.name).toBe("@deepseek-ai/dsh-agent-loop");
    expect(byId.get("tool-web")?.name).toBe("@deepseek-ai/dsh-tool-web");
  });

  it("静态禁用行为 boolean", () => {
    expect(byId.get("hmr")?.disabled).toBe(true);
    expect(byId.get("skill-badge")?.disabled).toBe(true);
    expect(byId.get("timer")?.disabled).toBeUndefined();
  });

  it("!!js 表达式原样保留、绝不求值（平台条件禁用与配置默认值）", () => {
    const pwsh = byId.get("pwsh-sandbox")?.disabled;
    expect(isJsExpr(pwsh)).toBe(true);
    if (isJsExpr(pwsh)) expect(pwsh.__jsExpr).toContain("process.platform");

    const mode = (byId.get("sandbox-policy")?.config as { mode?: unknown })?.mode;
    expect(isJsExpr(mode)).toBe(true);
    if (isJsExpr(mode)) expect(mode.__jsExpr).toContain("DSH_PERMISSION_MODE");
  });

  it("官方注释归到所属行", () => {
    // timer 是清单第一行, 上方无注释; hmr 的注释以 "Module reload" 开头
    expect(byId.get("timer")?.notes).toBeUndefined();
    expect(byId.get("hmr")?.notes ?? "").toContain("Module reload");
    const webNotes = byId.get("web")?.notes ?? "";
    expect(webNotes).toContain("web_search");
  });
});
