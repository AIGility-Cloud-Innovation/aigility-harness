/**
 * LLM 节点注册表（D2 模型算力层 · 机制）—— 移植自 hire_web_backend llm_node 模块
 * （cv_llm_provider / LLMNodeModel：命名的模型配置，业务按 node_name 引用）。
 *
 * 概念：一个「LLM 节点」= 名称唯一的一份模型配置（供应商 + 模型名 + 参数 + 流式开关）。
 * 工作流节点、角色模型偏好、任务管线都可按节点名取用，模型切换不改业务代码。
 *
 * 安全语义（对齐 hire）：供应商 api_key 只存 **env 占位符**（`{VAR_NAME}`），
 * 密钥本体不落库；resolveLLMNode 在运行时解析占位符。
 *
 * 分离纪律：机制在包（DDL/store 接口/解析），数据在站点（表在站点库，目录由站点 UI 维护）。
 */

// ── 模型 ────────────────────────────────────────────────────────

export interface LLMProvider {
  id: number;
  name: string;
  /** 供应商标识（volcengine/deepseek/glm/litellm…） */
  tag: string;
  /** API Key：存 env 占位符 `{VAR_NAME}` 或空（走平台统一上游时不需要） */
  apiKey: string;
  apiBase: string;
  enabled: boolean;
}

export interface LLMNodeConfig {
  id: number;
  /** 节点名（唯一，业务按名引用） */
  name: string;
  description: string;
  /** 业务模块标签（如 factory/taskloop），自由标注 */
  serviceModule: string;
  /** 功能名标签（如 briefing-judge），自由标注 */
  functionName: string;
  modelName: string;
  /** 模型参数（temperature/max_tokens/…，原样传给上游） */
  parameter: Record<string, unknown>;
  providerId: number;
  isStream: boolean;
}

/** 节点解析产物：可直接发起 OpenAI 兼容请求 */
export interface ResolvedLLMNode {
  node: string;
  model: string;
  baseUrl: string;
  /** 已解析出真实值的 key（env 占位符替换后）；仍保留占位符原样返回以防泄漏差异混淆 */
  apiKey: string;
  isStream: boolean;
  parameter: Record<string, unknown>;
}

// ── 存储接口（站点适配：PG / 内存）──────────────────────────────

export interface LLMNodeStore {
  listProviders(): Promise<LLMProvider[]>;
  getProvider(id: number): Promise<LLMProvider | null>;
  createProvider(p: { name: string; tag: string; apiKey?: string; apiBase?: string }): Promise<LLMProvider>;
  updateProvider(id: number, patch: Partial<Pick<LLMProvider, "name" | "tag" | "apiKey" | "apiBase" | "enabled">>): Promise<void>;
  listNodes(): Promise<LLMNodeConfig[]>;
  getNodeByName(name: string): Promise<LLMNodeConfig | null>;
  createNode(n: Omit<LLMNodeConfig, "id">): Promise<LLMNodeConfig>;
  updateNode(id: number, patch: Partial<Omit<LLMNodeConfig, "id" | "name">>): Promise<void>;
  deleteNode(id: number): Promise<void>;
}

// ── env 占位符解析 ──────────────────────────────────────────────

/** `{VAR_NAME}` → process.env.VAR_NAME；非占位符原样返回；未设置返回空串 */
export function resolveEnvPlaceholder(value: string, env: Record<string, string | undefined> = process.env): string {
  const m = /^\{([A-Z0-9_]+)\}$/.exec(value.trim());
  if (!m) return value;
  return env[m[1]] ?? "";
}

// ── 节点解析 ────────────────────────────────────────────────────

/** node_name → 可执行配置（供应商 base/key + 模型 + 参数） */
export async function resolveLLMNode(
  store: LLMNodeStore,
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedLLMNode> {
  const node = await store.getNodeByName(name);
  if (!node) throw new Error(`LLM 节点不存在: ${name}`);
  const provider = await store.getProvider(node.providerId);
  if (!provider) throw new Error(`LLM 节点 ${name} 的供应商不存在 (provider_id=${node.providerId})`);
  return {
    node: node.name,
    model: node.modelName,
    baseUrl: resolveEnvPlaceholder(provider.apiBase, env),
    apiKey: resolveEnvPlaceholder(provider.apiKey, env),
    isStream: node.isStream,
    parameter: node.parameter,
  };
}

/** DDL（站点库执行；幂等） */
export const LLM_NODE_DDL = `
CREATE TABLE IF NOT EXISTS llm_provider (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  tag VARCHAR(50) NOT NULL UNIQUE,
  api_key VARCHAR(255) NOT NULL DEFAULT '',
  api_base VARCHAR(255) NOT NULL DEFAULT '',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS llm_node (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255) NOT NULL DEFAULT '',
  service_module VARCHAR(100) NOT NULL DEFAULT '',
  function_name VARCHAR(100) NOT NULL DEFAULT '',
  model_name VARCHAR(255) NOT NULL,
  parameter JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_id BIGINT NOT NULL REFERENCES llm_provider(id),
  is_stream BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
