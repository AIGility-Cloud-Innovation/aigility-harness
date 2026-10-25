import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmSourcesStore } from "./llm-sources-store.js";

const FIXTURE = `model_list:
  - model_name: ksyun-deepseek-v4.1-flash
    litellm_params:
      model: openai/deepseek-v4.1-flash
      api_key: os.environ/KSYUN_API_KEY
      api_base: https://kspmas.ksyun.com/v1
      rpm: 1000
  - model_name: deepseek-v4.1-flash
    litellm_params:
      model: openai/deepseek-v4.1-flash
      api_key: os.environ/TIMEM_API_KEY
      api_base: https://api.timem.cloud/v1
  - model_name: bigmodel-glm-5.3-flash
    litellm_params:
      model: openai/glm-5.3-flash
      api_key: os.environ/BIGMODEL_API_KEY
      api_base: https://open.bigmodel.cn/api/paas/v4
litellm_settings:
  num_retries: 2
`;

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-sources-test-"));
  cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, FIXTURE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new LlmSourcesStore(cfgPath);

describe("LlmSourcesStore", () => {
  it("快照：按 api_base 分组来源并识别上游模型", () => {
    const snap = store().snapshot();
    expect(snap.sources).toHaveLength(3);
    const ksyun = snap.sources.find((s) => s.label.includes("KSyun"))!;
    expect(ksyun.models.map((m) => m.name)).toEqual(["ksyun-deepseek-v4.1-flash"]);
    const timem = snap.sources.find((s) => s.label.includes("Timem"))!;
    expect(timem.models[0].name).toBe("deepseek-v4.1-flash");
    expect(timem.keyRef).toBe("TIMEM_API_KEY");
  });

  it("别名新增：克隆目标上游参数，不改目标本身", () => {
    store().addAlias("deepseek-flash", "deepseek-v4.1-flash");
    const snap = store().snapshot();
    const timem = snap.sources.find((s) => s.label.includes("Timem"))!;
    expect(timem.models.map((m) => m.name).sort()).toEqual(["deepseek-flash", "deepseek-v4.1-flash"]);
    // 配置文件中目标条目未被改动
    const raw = readFileSync(cfgPath, "utf8");
    expect(raw.match(/model: openai\/deepseek-v4\.1-flash/g)?.length).toBe(3);
  });

  it("别名重复新增被拒绝", () => {
    store().addAlias("deepseek-flash", "deepseek-v4.1-flash");
    expect(() => store().addAlias("deepseek-flash", "deepseek-v4.1-flash")).toThrow(/已存在/);
  });

  it("模型移除：同路由仍有其他模型时允许", () => {
    store().addAlias("tmp-alias", "deepseek-v4.1-flash");
    const r = store().removeModel("tmp-alias");
    expect(r.removed).toBe(true);
    const snap = store().snapshot();
    expect(snap.sources.flatMap((s) => s.models.map((m) => m.name))).not.toContain("tmp-alias");
  });

  it("同路由最后一个模型拒绝移除（防来源悬空）", () => {
    expect(() => store().removeModel("deepseek-v4.1-flash")).toThrow(/来源悬空/);
  });

  it("移除不存在的模型被拒绝", () => {
    expect(() => store().removeModel("no-such-model")).toThrow(/不存在/);
  });

  it("保存产生备份文件且落在来源目录之外", () => {
    store().addAlias("tmp-x", "deepseek-v4.1-flash");
    const baks = readdirSync(dir).filter((f) => f.startsWith("config.yaml.bak-"));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
  });

  it("坏配置（缺 model_list）被拒绝管理", () => {
    writeFileSync(cfgPath, "foo: bar\n");
    expect(() => store().snapshot()).toThrow(/model_list/);
  });
});
