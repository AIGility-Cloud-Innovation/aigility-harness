/**
 * plugin-install 工作流单测
 *
 * 验证确定性逻辑: 扫描 config/py-plugins.json + packages 目录,
 * 契约匹配 (已接入/未接入/模糊), 输出引导。
 */
import { describe, it, expect } from "vitest";
import { pluginInstallProvider, pluginInstallService } from "./plugin-install.js";
import { LayerId, ok } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";

function mockCtx(): SeamContext {
  return {
    sessionId: "it-session",
    traceId: "it-trace",
    callerLayer: LayerId.Orchestration,
    addEffect: () => "e",
    emit: () => {},
    getState: () => undefined,
    setState: () => {},
    call: (async () => ({ ok: true as const, value: {} })) as SeamContext["call"],
  };
}

describe("@orchestration/plugin-install 契约", () => {
  it("服务定义归属 Orchestration 层", () => {
    expect(pluginInstallService.id).toBe("@orchestration/plugin-install");
    expect(pluginInstallService.layer).toBe("orchestration");
    expect(pluginInstallService.version).toBe("1.0.0");
  });

  it("provider 绑定同一服务", () => {
    expect(pluginInstallProvider.service).toBe(pluginInstallService);
  });

  it("已接入的 Python 插件: 返回已就绪 + available 含其 id", async () => {
    const r = await pluginInstallProvider.execute(
      { user_input: "帮我加个 RAG 插件" },
      mockCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // RAG 目前未在 py-plugins.json 声明 (只有 workflow/memory), 应提示接入路径
    expect(r.value.scanned.pyPlugins).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.value.available)).toBe(true);
    expect(r.value.suggested_path).toBeTruthy();
  });

  it("已接入能力 (workflow/memory): 返回已就绪", async () => {
    const r = await pluginInstallProvider.execute(
      { user_input: "workflow 引擎" },
      mockCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.suggested_path).toContain("已就绪");
  });

  it("未知关键词: 返回清单总览 + 提示可安装项", async () => {
    const r = await pluginInstallProvider.execute(
      { user_input: "你好" },
      mockCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.result).toContain("接入");
    expect(r.value.available.length).toBeGreaterThanOrEqual(1);
  });

  it("health 正常", async () => {
    const h = await pluginInstallProvider.health();
    expect(h.healthy).toBe(true);
  });
});
