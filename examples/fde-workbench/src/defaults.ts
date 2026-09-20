/**
 * fde-workbench 默认环境 —— 必须最先 import（先于 layer-* 模块求值）
 *
 * LLM 上游按环境自动选择（可显式设置 LLM_PROVIDER 覆盖）：
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
