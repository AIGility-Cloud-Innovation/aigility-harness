/**
 * LLMNodeStore 的 AppBase PG 实现 + 建表 + 种子（站点共享底座）。
 *
 * 位置说明：本文件住在 appbase 而非 aigility-platform —— 因为「按节点名取模型」
 * 是多个站点进程（platform / feishu-task-loop 等）的**共同**需求，
 * 而 appbase 是它们唯一共享的、且已具备 pg + layer-cognitive 依赖的底座。
 * 机制仍在 layer-cognitive（包），只有这份 PG 适配 + 种子属于站点。
 *
 * 数据纪律：供应商/节点目录由模型管理页维护；密钥只存 env 占位符。
 */
import { LLM_NODE_DDL, resolveNodeRequest, type LLMNodeConfig, type LLMNodeStore, type LLMProvider } from "@aigility-harness/layer-cognitive/llm-node";
import { pool } from "./admin-modules/context.js";

const provRow = (r: Record<string, unknown>): LLMProvider => ({
  id: Number(r.id), name: String(r.name), tag: String(r.tag),
  apiKey: String(r.api_key ?? ""), apiBase: String(r.api_base ?? ""), enabled: Boolean(r.is_enabled),
});
const nodeRow = (r: Record<string, unknown>): LLMNodeConfig => ({
  id: Number(r.id), name: String(r.name), description: String(r.description ?? ""),
  serviceModule: String(r.service_module ?? ""), functionName: String(r.function_name ?? ""),
  modelName: String(r.model_name), parameter: (r.parameter ?? {}) as Record<string, unknown>,
  providerId: Number(r.provider_id), isStream: Boolean(r.is_stream),
  enabled: r.is_enabled === undefined ? true : Boolean(r.is_enabled),
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
      "INSERT INTO llm_node (name, description, service_module, function_name, model_name, parameter, provider_id, is_stream, is_enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [n.name, n.description, n.serviceModule, n.functionName, n.modelName, JSON.stringify(n.parameter), n.providerId, n.isStream, n.enabled ?? true],
    );
    return nodeRow(rows[0]);
  }
  async updateNode(id: number, patch: Partial<LLMNodeConfig>): Promise<void> {
    await pool.query(
      `UPDATE llm_node SET
         description = COALESCE($2,description), service_module = COALESCE($3,service_module),
         function_name = COALESCE($4,function_name), model_name = COALESCE($5,model_name),
         parameter = COALESCE($6,parameter), provider_id = COALESCE($7,provider_id), is_stream = COALESCE($8,is_stream),
         is_enabled = COALESCE($9,is_enabled)
       WHERE id = $1`,
      [id, patch.description ?? null, patch.serviceModule ?? null, patch.functionName ?? null,
       patch.modelName ?? null, patch.parameter ? JSON.stringify(patch.parameter) : null,
       patch.providerId ?? null, patch.isStream ?? null, patch.enabled ?? null],
    );
  }
  async deleteNode(id: number): Promise<void> {
    await pool.query("DELETE FROM llm_node WHERE id = $1", [id]);
  }
}

let readyPromise: Promise<void> | null = null;

/**
 * 默认节点种子（幂等、**永不覆盖已被页面改过的行**）。
 *
 * 语义要点：
 * - `ON CONFLICT (name) DO NOTHING`：行已存在则完全不动。页面上改过的模型/参数
 *   不会因为重启或升级被冲掉 —— 这是本种子最容易踩的坑。
 * - 只种「没有就起不来 / 起不来就退回 env」的关键节点，不预设全部业务节点。
 * - 模型取值刻意与现有 env 默认对齐，使「走节点」与「走 env」首轮对拍结果一致；
 *   真正的模型切换由页面完成，不由代码预设。
 */
const SEED_NODES: Array<Omit<LLMNodeConfig, "id" | "providerId">> = [
  {
    name: "task-classify",
    description: "TiMEM 项目任务判定（消息是否是要 AI 执行的任务）",
    serviceModule: "timem",
    functionName: "classify",
    modelName: "qwen3.5",
    parameter: { temperature: 0, max_tokens: 200 },
    isStream: false,
    enabled: true,
  },
  {
    name: "task-judge",
    description: "群聊任务判定（task-pipeline 摘要/判定）",
    serviceModule: "taskloop",
    functionName: "judge",
    modelName: "qwen-turbo",
    parameter: { temperature: 0.2 },
    isStream: false,
    enabled: true,
  },
  {
    name: "report-summary",
    description: "报告摘要（团队记忆日报/晨报）",
    serviceModule: "report",
    functionName: "summary",
    modelName: "qwen-turbo",
    parameter: { temperature: 0.3 },
    isStream: false,
    enabled: true,
  },
  {
    name: "assistant-fallback",
    description: "小助理兜底模型（助手对话主模型）",
    serviceModule: "timem",
    functionName: "assistant",
    modelName: "ksyun-deepseek-v4.1-flash",
    parameter: { temperature: 0.3 },
    isStream: true,
    enabled: true,
  },
];

/** 建表 + 种子（幂等，进程内单次）：默认注入 LiteLLM 网关供应商（密钥走 env 占位符）+ 关键默认节点 */
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
    const provider = (await store.listProviders()).find((p) => p.tag === "litellm");
    if (!provider) return;

    // 逐条 DO NOTHING：已存在的名字（含页面上手配的）原样保留
    for (const n of SEED_NODES) {
      await pool.query(
        `INSERT INTO llm_node (name, description, service_module, function_name, model_name, parameter, provider_id, is_stream, is_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO NOTHING`,
        [n.name, n.description, n.serviceModule, n.functionName, n.modelName,
         JSON.stringify(n.parameter), provider.id, n.isStream, n.enabled],
      );
    }
  })();
  return readyPromise;
}

export const llmNodeStore = new PgLLMNodeStore();

/**
 * 站点侧「节点 → LlmInferenceRequest 三件套」解析器（供消费进程装配注入）。
 * 这里是 harness 包与站点 PG 之间的唯一接头：包内只有机制，数据只在站点。
 */
export const siteNodeRequest = (name: string) => resolveNodeRequest(llmNodeStore, name);

/**
 * 装配层一行接入：把站点节点解析器注入编排层端口。
 *
 * 消费进程 bootstrap 里调用（与 setNotifySend 同款位置）：
 *   await wireLlmNodes();                       // 默认「有节点就用、没有就退回 env」
 *
 * 语义要点：
 * - 默认**不 fail-fast**：DB 不可达/表不存在时只告警，进程照常以 env 兜底启动。
 *   模型配置是「可选的增强」，不该成为判定链路的启动前置条件。
 * - 返回是否成功接上，便于装配层按需决定要不要 fail-fast（传 throwOnError）。
 */
export async function wireLlmNodes(opts?: { throwOnError?: boolean }): Promise<boolean> {
  try {
    await ensureLlmNodeReady();
    // 动态 import：避免 `pg` 在不需要节点的进程里被强制加载
    const { setLlmNodeResolver } = await import("@aigility-harness/layer-orchestration");
    setLlmNodeResolver(siteNodeRequest);
    console.log("[llm-node] 节点解析器已装配（模型可在页面上按节点改，缺失自动退回 env）");
    return true;
  } catch (e) {
    const msg = `[llm-node] 装配失败，全部调用点退回 env 默认: ${String(e)}`;
    if (opts?.throwOnError) throw new Error(msg);
    console.warn(msg);
    return false;
  }
}
