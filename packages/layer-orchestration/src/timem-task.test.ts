/**
 * timem-task 单测 — TiMEM Project 真实执行桥接
 *
 * 验证:
 *   1. 服务定义归属 Orchestration 层
 *   2. 空 user_input 明确报错
 *   3. socket 路径解析（env 优先, 否则 XDG_CONFIG_HOME）
 *   4. 缺 UDS (ENOENT) 时错误信息提示执行引擎未就绪
 */
import { describe, it, expect } from "vitest";
import {
  timemTaskService,
  timemTaskProvider,
  timemTaskManifest,
  defaultSocketPath,
} from "./timem-task.js";
import { LayerId } from "@aigility-harness/core";

describe("timem-task", () => {
  it("服务定义归属 Orchestration 层, manifest provides timem-task", () => {
    expect(timemTaskService.id).toBe("@orchestration/timem-task");
    expect(timemTaskService.layer).toBe(LayerId.Orchestration);
    expect(timemTaskManifest.provides.some((s) => s.id === timemTaskService.id)).toBe(true);
  });

  it("空 user_input 明确报错", async () => {
    const result = await timemTaskProvider.execute(
      { user_input: "   " },
      {} as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("任务指令为空");
    }
  });

  it("socket 路径解析: env 优先", () => {
    const orig = process.env["TIMEM_AGENTD_SOCK"];
    process.env["TIMEM_AGENTD_SOCK"] = "/tmp/custom.sock";
    try {
      expect(defaultSocketPath()).toBe("/tmp/custom.sock");
    } finally {
      if (orig === undefined) delete process.env["TIMEM_AGENTD_SOCK"];
      else process.env["TIMEM_AGENTD_SOCK"] = orig;
    }
  });

  it("agentd 未就绪(ENOENT) 时提示执行引擎未就绪", async () => {
    const origSock = process.env["TIMEM_AGENTD_SOCK"];
    process.env["TIMEM_AGENTD_SOCK"] = "/nonexistent/agentd.sock";
    try {
      const result = await timemTaskProvider.execute(
        { user_input: "hello", user_id: "u1" },
        {} as never,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("执行引擎未就绪");
      }
    } finally {
      if (origSock === undefined) delete process.env["TIMEM_AGENTD_SOCK"];
      else process.env["TIMEM_AGENTD_SOCK"] = origSock;
    }
  });
});