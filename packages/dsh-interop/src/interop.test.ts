import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { HarnessInterop } from "@aigility-harness/core";
import { DshKernelAdapter } from "@aigility-harness/kernel-dsh";
import { DshInterop, dshSuiteVersions, mountDshRow } from "./index.js";

const TIMER = "@deepseek-ai/cordis-plugin-timer";

describe("DshInterop — HarnessInterop 契约符合性", () => {
  it("versions(): 家族/套件/内核版本与对齐保险丝", () => {
    const interop: HarnessInterop = new DshInterop();
    expect(interop.family).toBe("dsh");
    const v = interop.versions();
    expect(v.family).toBe("dsh");
    expect(v.suite).toBe("0.1.5-rc.2");
    expect(v.kernel).toBe("4.0.2");
    expect(v.aligned).toBe(true);
  });

  it("mount(): 官方插件行经中立契约可装载（timer 提供服务）", async () => {
    const interop: HarnessInterop = new DshInterop();
    const ctx = new Context();
    try {
      const r = await interop.mount(ctx, { id: "timer", name: TIMER });
      expect(r.status).toBe("mounted");
      // timer 插件挂载后向 Context 注入 timer 服务（Service 惰性启动）
      expect((ctx as unknown as { timer?: unknown }).timer).toBeTruthy();
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("mount(): disabled 行跳过；坏包名返回 failed 而非抛出", async () => {
    const interop: HarnessInterop = new DshInterop();
    const ctx = new Context();
    try {
      expect(await interop.mount(ctx, { id: "t", name: TIMER, disabled: true })).toEqual({
        status: "skipped",
        id: "t",
        reason: "disabled",
      });
      const bad = await interop.mount(ctx, { id: "x", name: "@no-such-pkg/zz" });
      expect(bad.status).toBe("failed");
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("mount(): substrate 类型不符抛 TypeError（编程错误不入 failed 通道）", async () => {
    const interop: HarnessInterop = new DshInterop();
    await expect(interop.mount({ nope: true }, { name: TIMER })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("dsh-interop — 与内核共存", () => {
  it("与 DshKernelAdapter 共存：适配器生命周期独立于行装载", async () => {
    const adapter = new DshKernelAdapter();
    const ctx = new Context();
    try {
      expect((await mountDshRow(ctx, { name: TIMER })).status).toBe("mounted");
      expect(adapter.isReady()).toBe(false);
      await adapter.init({
        mode: "prototype" as never,
        profile: "test",
        autoHotSwap: false,
        healthCheckIntervalMs: 10_000,
      });
      expect(adapter.isReady()).toBe(true);
    } finally {
      await ctx.fiber.dispose();
      await adapter.shutdown();
    }
  });

  it("dshSuiteVersions(): 套件精确锁定且 cordis 单实例", () => {
    const v = dshSuiteVersions();
    expect(v.dsh).toBe("0.1.5-rc.2");
    expect(v.dshBase).toBe("0.1.5-rc.2");
    expect(v.cordis).toBe("4.0.2");
    expect(v.cordisAligned).toBe(true);
  });
});
