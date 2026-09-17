import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { isJsExpr } from "./base-rows.js";
import {
  evaluateJsExpr,
  evaluateDeep,
  type JsExprEvalContext,
} from "./js-expr.js";
import {
  TELEMETRY_ROW_ID,
  composeProfileRows,
  mountComposedProfile,
  orderRowIndices,
  type DshPatchEntry,
} from "./profile-composer.js";

const js = (src: string) => ({ __jsExpr: src });
const TIMER = "@deepseek-ai/cordis-plugin-timer";

const evalCtx: JsExprEvalContext = {
  env: { DSH_TELEMETRY_MODE: "OFF", DSH_HOME: "/tmp/dsh-test" },
  platform: "win32",
  cwd: "/tmp/work",
};

describe("js-expr — 白名单求值器", () => {
  it("覆盖官方清单里实际出现的表达式形态", () => {
    expect(evaluateJsExpr(js("process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'"), { env: evalCtx.env })).toBe("OFF");
    expect(
      evaluateJsExpr(js("process.env.DSH_TELEMETRY_OTLP_URL ?? 'https://x/v1/logs'"), { env: evalCtx.env }),
    ).toBe("https://x/v1/logs");
    expect(evaluateJsExpr(js("process.env.MISSING_X ?? 'fallback'"), { env: {} })).toBe("fallback");
    expect(evaluateJsExpr(js("process.cwd()"), { cwd: "/w" })).toBe("/w");
    expect(evaluateJsExpr(js("process.platform === 'win32'"), { platform: "win32" })).toBe(true);
    expect(evaluateJsExpr(js("process.platform !== 'win32'"), { platform: "win32" })).toBe(false);
    expect(evaluateJsExpr(js("dshHomePath('sessions')"), { env: evalCtx.env })).toBe(
      process.platform === "win32" ? "\\tmp\\dsh-test\\sessions" : "/tmp/dsh-test/sessions",
    );
    // 官方 sandbox policy 行: 带括号的空合 + 比较 + 三元
    expect(
      evaluateJsExpr(
        js("(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"),
        { env: { DSH_PERMISSION_MODE: "read-only" } },
      ),
    ).toBe("ask");
    expect(
      evaluateJsExpr(
        js("(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"),
        { env: {} },
      ),
    ).toBe("ask");
  });

  it("拒绝白名单之外的任何语法", () => {
    for (const bad of [
      "process.exit(1)",
      "require('node:fs')",
      "globalThis",
      "(() => 1)()",
      "`x${process.platform}`",
      "process.env.A = 'x'",
      "process + 1",
      "unknownFn('x')",
      "process.env",
      "1 + 2",
      "",
    ]) {
      expect(() => evaluateJsExpr(js(bad), { env: {} })).toThrow(/白名单求值拒绝/);
    }
  });

  it("evaluateDeep: 深遍历替换配置树里的 JsExpr", () => {
    const out = evaluateDeep(
      {
        mode: js("process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'"),
        nested: { list: [1, js("process.cwd()")], keep: "x" },
      },
      { env: evalCtx.env, cwd: "/c" },
    );
    expect(out).toEqual({ mode: "OFF", nested: { list: [1, "/c"], keep: "x" } });
  });
});

describe("profile-composer — 组合（官方 applyEntryPatches 语义）", () => {
  it("dsh-base 全量组合: 有效行 + 遥测默认硬关闭", () => {
    const { rows, warnings } = composeProfileRows();
    expect(rows.length).toBeGreaterThan(40);
    expect(warnings).toEqual([]);
    const telemetry = rows.find((r) => r.id === TELEMETRY_ROW_ID);
    expect(telemetry?.disabled).toBe(true);
    // `!!js` 保持原文不求值（平台门控行）
    const bashRow = rows.find((r) => typeof r.disabled === "object" && isJsExpr(r.disabled));
    expect(bashRow).toBeTruthy();
  });

  it("disableTelemetry: false 保留官方默认", () => {
    const { rows } = composeProfileRows({ disableTelemetry: false });
    const telemetry = rows.find((r) => r.id === TELEMETRY_ROW_ID);
    expect(telemetry?.disabled).not.toBe(true);
  });

  it("覆盖补丁: 按 id 定位，config 整体替换（last-write-wins）", () => {
    const patch: DshPatchEntry[] = [
      { id: "agent-default-model", config: { provider: "x", model: "m-1" } },
    ];
    const { rows, warnings } = composeProfileRows({ patches: [patch], disableTelemetry: false });
    expect(warnings).toEqual([]);
    const row = rows.find((r) => r.id === "agent-default-model");
    expect(row?.config).toEqual({ provider: "x", model: "m-1" });
  });

  it("name 不匹配 / 缺 id / 目标缺失 → 告警跳过不抛错", () => {
    const patch: DshPatchEntry[] = [
      { id: TELEMETRY_ROW_ID, name: "@wrong/pkg", disabled: true },
      { disabled: true },
      { id: "no-such-row", config: {} },
    ];
    const { warnings } = composeProfileRows({ patches: [patch], disableTelemetry: false });
    expect(warnings.some((w) => w.includes("name 不匹配"))).toBe(true);
    expect(warnings.some((w) => w.includes("缺 id"))).toBe(true);
    expect(warnings.some((w) => w.includes("no-such-row"))).toBe(true);
  });

  it("insert: 无 id 追加到根；带 id 追加进 group 条目", () => {
    const groupLayer: DshPatchEntry[] = [
      { insert: [{ id: "g", name: "some/group-loader", group: true, config: [] }] },
    ];
    const addRows: DshPatchEntry[] = [
      { id: "g", insert: [{ id: "child", name: "some/child" }] },
      { insert: [{ id: "root-row", name: "some/root" }] },
    ];
    const { rows, warnings } = composeProfileRows({
      bundles: [],
      patches: [groupLayer, addRows],
      disableTelemetry: false,
    });
    expect(warnings).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual(["g", "root-row"]);
    expect((rows[0].config as unknown[]).map((c) => (c as { id: string }).id)).toEqual(["child"]);
  });

  it("bundle 缺 dsh.bundle 清单 → 明确报错", () => {
    expect(() => composeProfileRows({ bundles: ["js-yaml"], disableTelemetry: false })).toThrow(
      /dsh\.bundle/,
    );
  });
});

describe("profile-composer — 依赖感知成组装载", () => {
  it("orderRowIndices: 供给者先行；环退回原序并告警", () => {
    const { order } = orderRowIndices([
      { provides: [], injects: ["svc"] }, // 0 依赖 svc（由 1 提供）
      { provides: ["svc"], injects: [] }, // 1
      { provides: [], injects: [] }, // 2 无关
    ]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(0));
    const cyc = orderRowIndices([
      { provides: ["a"], injects: ["b"] },
      { provides: ["b"], injects: ["a"] },
    ]);
    expect(cyc.order).toEqual([0, 1]);
    expect(cyc.warnings.length).toBe(1);
  });

  it("mountComposedProfile: 平台门控行求值跳过 + cordis 服务唯一去重 + dryRun", async () => {
    const ctx = new Context();
    try {
      const rows = [
        { id: "win-only", name: TIMER, disabled: js("process.platform !== 'win32'") },
        { id: "timer", name: TIMER, config: { keep: 1 } },
        { id: "never", name: TIMER, disabled: true },
      ];
      const r = await mountComposedProfile(ctx, rows, {
        evalCtx: { platform: "win32" },
      });
      // win-only 经 !!js 求值后激活；timer 与 win-only 同插件 → 去重 skipped
      expect(r.skipped).toBe(1);
      expect(r.failed).toBe(0);
      expect(r.results.map((x) => x.status)).toEqual(["mounted", "skipped"]);
      expect(r.results[1].reason).toContain("duplicate");
      expect((ctx as unknown as { timer?: unknown }).timer).toBeTruthy();

      const dry = await mountComposedProfile(ctx, rows, { dryRun: true });
      expect(dry.results).toEqual([]);
      expect(dry.skipped).toBe(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("mountComposedProfile: 干净组合成组装载 + 重复行去重告警", async () => {
    const ctx = new Context();
    try {
      const { rows } = composeProfileRows({
        bundles: [],
        patches: [[{ insert: [{ id: "t1", name: TIMER }, { id: "t2", name: TIMER }] }]],
        disableTelemetry: false,
      });
      expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
      const r = await mountComposedProfile(ctx, rows);
      expect(r.warnings).toEqual([]);
      expect(r.mounted).toBe(1);
      expect(r.failed).toBe(0);
      expect(r.results[1].status).toBe("skipped");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
