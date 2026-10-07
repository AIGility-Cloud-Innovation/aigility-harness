/**
 * LLM 节点存储已上收到 AppBase 底座（examples/appbase/src/llm-node-store.ts）。
 *
 * 原因：「按节点名取模型」是 platform / feishu-task-loop 等多个站点
 * 进程的共同需求，PG 适配 + 种子只该写一份；本文件保留为兼容 re-export，
 * 页面路由（src/index.ts）继续从这里取，业务不改一行。
 */
export {
  PgLLMNodeStore,
  ensureLlmNodeReady,
  llmNodeStore,
  siteNodeRequest,
  wireLlmNodes,
} from "@aigility-harness/appbase/llm-node-store";
