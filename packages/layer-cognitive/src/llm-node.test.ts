import { describe, expect, it } from "vitest";
import { LLM_NODE_DDL, buildNodeRequest, resolveEnvPlaceholder, resolveLLMNode, resolveNodeRequest, type LLMNodeConfig, type LLMNodeStore, type LLMProvider } from "./llm-node.js";

class MemoryStore implements LLMNodeStore {
  providers: LLMProvider[] = [{ id: 1, name: "LiteLLM 网关", tag: "litellm", apiKey: "{LITELLM_KEY}", apiBase: "http://127.0.0.1:48724", enabled: true }];
  nodes: LLMNodeConfig[] = [
    { id: 1, name: "briefing-judge", description: "群聊判定", serviceModule: "taskloop", functionName: "judge", modelName: "qwen-turbo", parameter: { temperature: 0.2 }, providerId: 1, isStream: false, enabled: true },
    { id: 2, name: "task-classify", description: "任务判定", serviceModule: "timem", functionName: "classify", modelName: "qwen3.5", parameter: { temperature: 0, max_tokens: 200 }, providerId: 1, isStream: false, enabled: true },
    { id: 3, name: "stopped-node", description: "已停用", serviceModule: "timem", functionName: "classify", modelName: "glm-4.6", parameter: {}, providerId: 1, isStream: false, enabled: false },
  ];
  async listProviders() { return this.providers; }
  async getProvider(id: number) { return this.providers.find((p) => p.id === id) ?? null; }
  async createProvider(p: { name: string; tag: string; apiKey?: string; apiBase?: string }) {
    const prov: LLMProvider = { id: this.providers.length + 1, name: p.name, tag: p.tag, apiKey: p.apiKey ?? "", apiBase: p.apiBase ?? "", enabled: true };
    this.providers.push(prov);
    return prov;
  }
  async updateProvider(id: number, patch: Partial<LLMProvider>) {
    const i = this.providers.findIndex((p) => p.id === id);
    if (i >= 0) this.providers[i] = { ...this.providers[i], ...patch };
  }
  async listNodes() { return this.nodes; }
  async getNodeByName(name: string) { return this.nodes.find((n) => n.name === name) ?? null; }
  async createNode(n: Omit<LLMNodeConfig, "id">) { const node = { ...n, id: this.nodes.length + 1 }; this.nodes.push(node); return node; }
  async updateNode(id: number, patch: Partial<LLMNodeConfig>) {
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i >= 0) this.nodes[i] = { ...this.nodes[i], ...patch };
  }
  async deleteNode(id: number) { this.nodes = this.nodes.filter((n) => n.id !== id); }
}

describe("LLM 节点注册表（D2 模型算力层）", () => {
  it("resolve：节点名 → 供应商 base/key + 模型 + 参数", async () => {
    const r = await resolveLLMNode(new MemoryStore(), "briefing-judge", { LITELLM_KEY: "sk-1234" });
    expect(r?.model).toBe("qwen-turbo");
    expect(r?.baseUrl).toBe("http://127.0.0.1:48724");
    expect(r?.apiKey).toBe("sk-1234");
    expect(r?.isStream).toBe(false);
    expect(r?.parameter).toEqual({ temperature: 0.2 });
  });

  it("env 占位符：{VAR} 解析、非占位符原样、未设置返回空", () => {
    expect(resolveEnvPlaceholder("{FOO_KEY}", { FOO_KEY: "v1" })).toBe("v1");
    expect(resolveEnvPlaceholder("sk-plain", {})).toBe("sk-plain");
    expect(resolveEnvPlaceholder("{NOT_SET}", {})).toBe("");
  });

  it("节点不存在 → null（不抛；业务侧走 env 兜底）", async () => {
    expect(await resolveLLMNode(new MemoryStore(), "nope")).toBeNull();
  });

  it("供应商缺失 → null", async () => {
    const store = new MemoryStore();
    store.providers = [];
    expect(await resolveLLMNode(store, "briefing-judge")).toBeNull();
  });

  it("节点停用 → null（等同于不存在，可一键回滚）", async () => {
    expect(await resolveLLMNode(new MemoryStore(), "stopped-node")).toBeNull();
  });

  it("buildNodeRequest：参数当默认值、model 透传、上游齐备才给 upstream", async () => {
    const parts = buildNodeRequest(await resolveLLMNode(new MemoryStore(), "task-classify", { LITELLM_KEY: "sk-1234" }));
    expect(parts?.node).toBe("task-classify");
    expect(parts?.model).toBe("qwen3.5");
    expect(parts?.parameter).toEqual({ temperature: 0, max_tokens: 200 });
    // apiBase 与 apiKey 都非空 → 给 upstream（站点自带上游优先级高于 env 全局）
    expect(parts?.upstream).toEqual({ url: "http://127.0.0.1:48724", key: "sk-1234" });
  });

  it("buildNodeRequest：apiKey 解析为空串 → 不给 upstream（退回 env 全局上游）", async () => {
    // 未提供 LITELLM_KEY → 占位符解析为空串 → 不应产生半截 upstream
    const parts = buildNodeRequest(await resolveLLMNode(new MemoryStore(), "task-classify", {}));
    expect(parts?.upstream).toBeUndefined();
    expect(parts?.model).toBe("qwen3.5");
  });

  it("buildNodeRequest(null) → null", () => {
    expect(buildNodeRequest(null)).toBeNull();
  });

  it("resolveNodeRequest：节点缺失返回 null 而非抛错", async () => {
    expect(await resolveNodeRequest(new MemoryStore(), "missing")).toBeNull();
    expect((await resolveNodeRequest(new MemoryStore(), "task-classify"))?.model).toBe("qwen3.5");
  });

  it("默认值优先级的展开语义：调用点显式字段覆盖 parameter", async () => {
    const parts = await resolveNodeRequest(new MemoryStore(), "task-classify");
    // 业务侧展开顺序：...parameter 在前，显式字段在后
    const req = { ...parts?.parameter, temperature: 0.9 };
    expect(req.temperature).toBe(0.9);
    expect(req.max_tokens).toBe(200);
  });

  it("DDL 含两张表且幂等关键字", () => {
    expect(LLM_NODE_DDL).toContain("CREATE TABLE IF NOT EXISTS llm_provider");
    expect(LLM_NODE_DDL).toContain("CREATE TABLE IF NOT EXISTS llm_node");
  });

  it("DDL 为既有库补 is_enabled 列（幂等迁移）", () => {
    expect(LLM_NODE_DDL).toContain("ADD COLUMN IF NOT EXISTS is_enabled");
  });
});
