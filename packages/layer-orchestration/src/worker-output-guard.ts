/**
 * 工人输出报错特征判定（2026-10-22 事故防线）：
 * claude/codex CLI 遇网关 4xx/5xx 时可能仍 exit 0，把「API Error: 400 …」当最终输出
 * 交给收尾器 → 曾被原样写进 PR 正文当「交付报告」（timem_console_frontend#86 事故）。
 * 内层：worker-team 对 ok 结果先过本判定 → 命中按失败处理（不进交付）。
 * 外层：pr-finisher 建_PR 前再过一遍 → 任何路径都不允许报错原文进 PR 正文。
 */
export const WORKER_ERROR_SIGNATURES: RegExp[] = [
  /API Error: \d{3}/, // OpenAI/Anthropic SDK 风格：API Error: 400/500…
  /Invalid model name passed in model=/, // LiteLLM：模型名不在网关
  /Call `?\/v1\/models`?/, // 同上报错指引句
  /litellm\.(APIError|exceptions)/, // LiteLLM 异常类型名
  /consumer has not enabled this model/, // 天翼/ksyun 侧模型未开通
  /unexpected status \d{3}/, // codex：unexpected status 403 Forbidden…
  /\b(?:RateLimitError|AuthenticationError|APIConnectionError|NotFoundError)\b/, // litellm/openai 异常名
  /model=\S+ .*not found/i,
];

/** 工人最终输出是否疑似网关/API 报错（而非交付内容） */
export function looksLikeGatewayError(text: string): boolean {
  if (!text) return false;
  return WORKER_ERROR_SIGNATURES.some((re) => re.test(text));
}
