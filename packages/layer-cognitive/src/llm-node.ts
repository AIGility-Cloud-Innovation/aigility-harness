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
  /**
   * 停用 = 不参与解析（resolveLLMNode 返回 null → 业务侧退回 env 兜底）。
   * 与「删除」的区别：停用保留配置，改错了能一键回滚。
   */
  enabled: boolean;
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
  /** 透传节点停用态；resolveLLMNode 已据此返回 null，此处仅供 UI/诊断 */
  enabled: boolean;
}

/**
 * 节点请求桥产物：业务侧把它展开进 LlmInferenceRequest 即可
 * （model 必填；upstream/parameter 可选，缺省表示「按全局 env 走」）。
 */
export interface LlmNodeRequestParts {
  /** 来源节点名（未解析出节点时为 undefined，便于日志区分「节点」与「env 兜底」） */
  node?: string;
  model?: string;
  /** 站点自带上游（url+key 都非空才给）；缺省走 LLM_PROVIDER/env 全局 */
  upstream?: { url: string; key: string };
  /** 节点级默认参数（temperature/max_tokens/…）；调用点显式字段应覆盖它 */
  parameter?: Record<string, unknown>;
  isStream?: boolean;
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

/** node_name → 可执行配置（供应商 base/key + 模型 + 参数）；节点或供应商缺失 → null（业务侧回退 env） */
export async function resolveLLMNode(
  store: LLMNodeStore,
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedLLMNode | null> {
  const node = await store.getNodeByName(name);
  if (!node) return null;
  // 停用节点视同不存在：业务侧统一走「节点缺失 → env 兜底」这一条路径
  if (node.enabled === false) return null;
  const provider = await store.getProvider(node.providerId);
  if (!provider) return null;
  return {
    node: node.name,
    model: node.modelName,
    baseUrl: resolveEnvPlaceholder(provider.apiBase, env),
    apiKey: resolveEnvPlaceholder(provider.apiKey, env),
    isStream: node.isStream,
    parameter: node.parameter,
    enabled: node.enabled,
  };
}

/**
 * 节点名 → LlmInferenceRequest 三件套（业务侧唯一入口；纯函数，无 IO）。
 *
 * 失败语义是**有意的**：节点不存在 / 供应商缺失 / 该节点被停用 → 返回 null，
 * 业务侧必须回退到 env 默认值。配错一个名字不能让整条链路断掉。
 *
 * 优先级语义：本函数只给「默认值」，调用点之后显式写的 model/temperature 等
 * 字段自然覆盖（业务侧展开顺序：...parts.parameter 在前，显式字段在后）。
 */
export function buildNodeRequest(resolved: ResolvedLLMNode | null): LlmNodeRequestParts | null {
  if (!resolved) return null;
  const upstream =
    resolved.baseUrl && resolved.apiKey
      ? { url: resolved.baseUrl, key: resolved.apiKey }
      : undefined;
  return {
    node: resolved.node,
    model: resolved.model || undefined,
    ...(upstream ? { upstream } : {}),
    parameter: resolved.parameter ?? {},
    isStream: resolved.isStream,
  };
}

/** buildNodeRequest ∘ resolveLLMNode 的组合便捷入口（查库失败/节点缺失一律 null，不抛） */
export async function resolveNodeRequest(
  store: LLMNodeStore,
  name: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LlmNodeRequestParts | null> {
  return buildNodeRequest(await resolveLLMNode(store, name, env));
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
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 既有库补列（CREATE TABLE IF NOT EXISTS 不会给老表加列）
ALTER TABLE llm_node ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT true;
`;
