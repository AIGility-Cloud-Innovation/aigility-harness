/**
 * LLMNodeStore 的 AppBase PG 实现 + 建表 + 种子（智悦站点适配）。
 * 数据在站点：供应商/节点目录由模型管理页维护；密钥只存 env 占位符。
 */
import { LLM_NODE_DDL, type LLMNodeConfig, type LLMNodeStore, type LLMProvider } from "@aigility-harness/layer-cognitive/llm-node";
import { pool } from "@aigility-harness/appbase/backend";

const provRow = (r: Record<string, unknown>): LLMProvider => ({
  id: Number(r.id), name: String(r.name), tag: String(r.tag),
  apiKey: String(r.api_key ?? ""), apiBase: String(r.api_base ?? ""), enabled: Boolean(r.is_enabled),
});
const nodeRow = (r: Record<string, unknown>): LLMNodeConfig => ({
  id: Number(r.id), name: String(r.name), description: String(r.description ?? ""),
  serviceModule: String(r.service_module ?? ""), functionName: String(r.function_name ?? ""),
  modelName: String(r.model_name), parameter: (r.parameter ?? {}) as Record<string, unknown>,
  providerId: Number(r.provider_id), isStream: Boolean(r.is_stream),
});

export class PgLLMNodeStore implements LLMNodeStore {
  async listProviders(): Promise<LLMProvider[]> {
    const { rows } = await pool.query("SELECT * FROM llm_provider WHERE is_enabled ORDER BY id");
    return rows.map(provRow);
  }
  async getProvider(id: number): Promise<LLMProvider | null> {
    const { rows } = await pool.query("SELECT * FROM llm_provider WHERE id = $1", [id]);
    return rows[0] ? provRow(rows[0]) : null;
  }
  async createProvider(p: { name: string; tag: string; apiKey?: string; apiBase?: string }): Promise<LLMProvider> {
    const { rows } = await pool.query(
      "INSERT INTO llm_provider (name, tag, api_key, api_base) VALUES ($1,$2,$3,$4) RETURNING *",
      [p.name, p.tag, p.apiKey ?? "", p.apiBase ?? ""],
    );
    return provRow(rows[0]);
  }
  async updateProvider(id: number, patch: Partial<LLMProvider>): Promise<void> {
    await pool.query(
      "UPDATE llm_provider SET name = COALESCE($2,name), tag = COALESCE($3,tag), api_key = COALESCE($4,api_key), api_base = COALESCE($5,api_base), is_enabled = COALESCE($6,is_enabled) WHERE id = $1",
      [id, patch.name ?? null, patch.tag ?? null, patch.apiKey ?? null, patch.apiBase ?? null, patch.enabled ?? null],
    );
  }
  async listNodes(): Promise<LLMNodeConfig[]> {
    const { rows } = await pool.query("SELECT * FROM llm_node ORDER BY id");
    return rows.map(nodeRow);
  }
  async getNodeByName(name: string): Promise<LLMNodeConfig | null> {
    const { rows } = await pool.query("SELECT * FROM llm_node WHERE name = $1", [name]);
    return rows[0] ? nodeRow(rows[0]) : null;
  }
  async createNode(n: Omit<LLMNodeConfig, "id">): Promise<LLMNodeConfig> {
    const { rows } = await pool.query(
      "INSERT INTO llm_node (name, description, service_module, function_name, model_name, parameter, provider_id, is_stream) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [n.name, n.description, n.serviceModule, n.functionName, n.modelName, JSON.stringify(n.parameter), n.providerId, n.isStream],
    );
    return nodeRow(rows[0]);
  }
  async updateNode(id: number, patch: Partial<LLMNodeConfig>): Promise<void> {
    await pool.query(
      `UPDATE llm_node SET
         description = COALESCE($2,description), service_module = COALESCE($3,service_module),
         function_name = COALESCE($4,function_name), model_name = COALESCE($5,model_name),
         parameter = COALESCE($6,parameter), provider_id = COALESCE($7,provider_id), is_stream = COALESCE($8,is_stream)
       WHERE id = $1`,
      [id, patch.description ?? null, patch.serviceModule ?? null, patch.functionName ?? null,
       patch.modelName ?? null, patch.parameter ? JSON.stringify(patch.parameter) : null,
       patch.providerId ?? null, patch.isStream ?? null],
    );
  }
  async deleteNode(id: number): Promise<void> {
    await pool.query("DELETE FROM llm_node WHERE id = $1", [id]);
  }
}

let readyPromise: Promise<void> | null = null;

/** 建表 + 种子（幂等，进程内单次）：默认注入 LiteLLM 网关供应商（密钥走 env 占位符） */
export function ensureLlmNodeReady(): Promise<void> {
  readyPromise ??= (async () => {
    await pool.query(LLM_NODE_DDL);
    const store = new PgLLMNodeStore();
    const providers = await store.listProviders();
    if (!providers.some((p) => p.tag === "litellm")) {
      await store.createProvider({
        name: "LiteLLM 网关",
        tag: "litellm",
        apiKey: "{LITELLM_KEY}",
        apiBase: "{LITELLM_URL}",
      });
    }
  })();
  return readyPromise;
}

export const llmNodeStore = new PgLLMNodeStore();
