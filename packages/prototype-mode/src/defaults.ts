/**
 * prototype-mode 默认环境 —— 必须最先 import(先于 layer-* 模块求值)
 *
 * - LLM_PROVIDER=stub: 原型模式零外部依赖(确定性 echo 推理);
 *   需要真实推理时显式设置 LLM_PROVIDER=litellm 或 bigmodel 覆盖。
 * - APPBASE_URL: 最小 UI 顶部「注册/登录 AppBase」提示条的跳转地址;
 *   置空可去掉提示条。
 */
process.env.LLM_PROVIDER ??= "stub";
process.env.APPBASE_URL ??= "http://127.0.0.1:3419/hall";
