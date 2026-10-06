import { describe, expect, it } from "vitest";
import { LLM_NODE_DDL, resolveEnvPlaceholder, resolveLLMNode, type LLMNodeConfig, type LLMNodeStore, type LLMProvider } from "./llm-node.js";

class MemoryStore implements LLMNodeStore {
  providers: LLMProvider[] = [{ id: 1, name: "LiteLLM 网关", tag: "litellm", apiKey: "{LITELLM_KEY}", apiBase: "http://127.0.0.1:48724", enabled: true }];
  nodes: LLMNodeConfig[] = [
    { id: 1, name: "briefing-judge", description: "群聊判定", serviceModule: "taskloop", functionName: "judge", modelName: "qwen-turbo", parameter: { temperature: 0.2 }, providerId: 1, isStream: false },
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
    expect(r.model).toBe("qwen-turbo");
    expect(r.baseUrl).toBe("http://127.0.0.1:48724");
    expect(r.apiKey).toBe("sk-1234");
    expect(r.isStream).toBe(false);
    expect(r.parameter).toEqual({ temperature: 0.2 });
  });

  it("env 占位符：{VAR} 解析、非占位符原样、未设置返回空", () => {
    expect(resolveEnvPlaceholder("{FOO_KEY}", { FOO_KEY: "v1" })).toBe("v1");
    expect(resolveEnvPlaceholder("sk-plain", {})).toBe("sk-plain");
    expect(resolveEnvPlaceholder("{NOT_SET}", {})).toBe("");
  });

  it("节点不存在报错（含名字）", async () => {
    await expect(resolveLLMNode(new MemoryStore(), "nope")).rejects.toThrow("nope");
  });

  it("DDL 含两张表且幂等关键字", () => {
    expect(LLM_NODE_DDL).toContain("CREATE TABLE IF NOT EXISTS llm_provider");
    expect(LLM_NODE_DDL).toContain("CREATE TABLE IF NOT EXISTS llm_node");
  });
});
