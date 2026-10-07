/**
 * LLM 节点解析端口（编排层侧）—— 与 setNotifySend / setDispatchNotifySend 同款装配约定。
 *
 * 为什么是「端口」而不是直接 import layer-cognitive：
 *   编排层只依赖 core。节点机制在 layer-cognitive（包内），节点数据在站点 PG。
 *   若编排层直连 PG/机制包，就打破了「每层只依赖比自己小的层号」的单向依赖规则，
 *   也会把 PG 依赖拖进编排包。因此这里只声明**结构类型**（鸭子类型），
 *   由装配层在 bootstrap 时把站点实现注进来。
 *
 * 失败语义（与机制层一致，业务侧据此回退）：
 *   - 未装配端口 → 解析器返回 null
 *   - 节点不存在 / 供应商缺失 / 节点停用 → null
 *   任何情况下都不抛：配错一个节点名不能让判定链路断掉。
 */

/** 与 layer-cognitive 的 LlmNodeRequestParts 结构等价（避免跨层 import） */
export interface LlmNodeParts {
  node?: string;
  model?: string;
  upstream?: { url: string; key: string };
  parameter?: Record<string, unknown>;
  isStream?: boolean;
}

/** 站点注入的解析器：节点名 → 三件套；缺失返回 null */
export type LlmNodeResolver = (name: string) => Promise<LlmNodeParts | null>;

let llmNodeResolver: LlmNodeResolver | undefined;

/** 装配层注入（传 undefined 可卸载，便于测试复位） */
export function setLlmNodeResolver(fn: LlmNodeResolver | undefined): void {
  llmNodeResolver = fn;
}

/**
 * 按节点名取「模型默认值/上游/参数」。
 * 未装配、节点缺失、或解析抛异常 → 一律 null，调用方走 env 兜底。
 */
export async function nodeRequest(name: string): Promise<LlmNodeParts | null> {
  if (!llmNodeResolver) return null;
  try {
    return await llmNodeResolver(name);
  } catch (e) {
    console.warn(`[llm-node-port] 节点解析失败（回退 env）: ${name} — ${String(e)}`);
    return null;
  }
}

/**
 * 把节点三件套合进 LlmInferenceRequest（不含 messages）。
 *
 * 优先级语义（本函数是唯一的合并点，务必只此一处）：
 *   parameter 当**默认值** → ...展开在前；调用点显式字段 → 写在后。
 * 这样「节点配 temperature=0.2」不会压过调用点刻意要的 temperature=0。
 *
 * upstream 仅在节点自带上游（url+key 齐备）时才覆盖，否则保持 undefined
 * 让 provider 走 LLM_PROVIDER/env 全局。
 */
export function withNodeDefaults<T>(parts: LlmNodeParts | null, request: T): T {
  if (!parts) return request;
  return {
    ...(parts.parameter ?? {}),
    ...(parts.upstream ? { upstream: parts.upstream } : {}),
    ...request,
  };
}