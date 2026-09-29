import { describe, expect, it } from "vitest";
import {
  createDshWorkflowRunner,
  createDshWorkflowRunProvider,
  dshWorkflowRunRef,
  dshWorkflowRunService,
  resolveWorkflowRuntime,
} from "./workflow-service.js";

const REQ = {
  script: "return 1",
  meta: { name: "t", description: "d" },
  args: { x: 1 },
};

describe("resolveWorkflowRuntime", () => {
  it("装配参数优先于 env；缺配置项如实上报", () => {
    const prev = { ...process.env };
    process.env.DSH_HOME = "/env-home";
    process.env.DEEPSEEK_API_KEY = "env-key";
    delete process.env.DEEPSEEK_BASE_URL;
    try {
      const { missing, runtime } = resolveWorkflowRuntime({
        dshHome: "/opt-home",
        apiKey: "opt-key",
        baseURL: "http://x",
      });
      expect(missing).toEqual([]);
      expect(runtime.dshHome).toBe("/opt-home");

      const fromEnv = resolveWorkflowRuntime({});
      expect(fromEnv.missing).toEqual(["DEEPSEEK_BASE_URL"]);
      expect(fromEnv.runtime.dshHome).toBe("/env-home");
    } finally {
      process.env = prev;
    }
  });
});

describe("createDshWorkflowRunner", () => {
  it("缺配置时直接返回失败 outcome，不 spawn", async () => {
    const prev = { ...process.env };
    delete process.env.DSH_HOME;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    try {
      const outcome = await createDshWorkflowRunner({}).runWorkflow(REQ);
      expect(outcome.ok).toBe(false);
      expect(outcome.parsed).toBe(false);
      expect(outcome.error).toContain("DSH_HOME");
      expect(outcome.durationMs).toBe(0);
    } finally {
      process.env = prev;
    }
  });
});

describe("createDshWorkflowRunProvider", () => {
  it("服务 id/ref 对齐，健康与执行随配置缺省而失败", async () => {
    expect(dshWorkflowRunRef.id).toBe(dshWorkflowRunService.id);
    expect(dshWorkflowRunService.layer).toBe("orchestration");

    const prev = { ...process.env };
    delete process.env.DSH_HOME;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    try {
      const p = createDshWorkflowRunProvider({});
      const health = await p.health();
      expect(health.healthy).toBe(false);
      expect(health.detail).toContain("DSH_HOME");
      const res = await p.execute(REQ, {} as never);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("DEEPSEEK_API_KEY");
    } finally {
      process.env = prev;
    }
  });
});
