/**
 * aigility-platform 默认环境 —— 必须最先 import（先于 layer-* 模块求值）
 *
 * LLM 上游按环境自动选择（可显式设置 LLM_PROVIDER 覆盖），与 fde-workbench 同策略：
 *   - BIGMODEL_API_KEY 存在        → bigmodel（智谱开放平台直连）
 *   - LITELLM_URL / LITELLM_KEY 存在 → litellm（LiteLLM 网关）
 *   - 都缺省                       → stub（确定性降级推理，链路仍通、回复带【服务降级】标记）
 */

if (!process.env.LLM_PROVIDER) {
  process.env.LLM_PROVIDER = process.env.BIGMODEL_API_KEY
    ? "bigmodel"
    : (process.env.LITELLM_URL || process.env.LITELLM_KEY)
      ? "litellm"
      : "stub";
}

// requirement-store（code 执行器的需求缓冲）缺省纯内存重启即丢 —— 示例默认落盘到 data/
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
if (!process.env.TIMEM_REQUIREMENT_STORE_PATH) {
  process.env.TIMEM_REQUIREMENT_STORE_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)), "../data/requirement-store.json");
}
