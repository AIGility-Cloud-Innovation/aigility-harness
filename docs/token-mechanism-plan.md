# aigility-harness 省 Token 机制方案（三体系合订版 × 本仓落地版）

> 2026-10-07 制定。输入材料：`docs/token-saving-cheatsheet.md`（DSH 实测版）、
> `docs/local-qwen3.5-access-notes.md`（本机 qwen3.5 接入事实）、
> 《省Token实战秘籍-三体系合订版》（Hermes/OpenClaw/DSH 合并）、
> 《token-saving-秘籍》（ZCode 实测版，含网关五路由缓存探针数据）。
> 结论先行：**可以，且有一个当天见效的修复点（M1）**；但 harness 不需要照搬全套四道闸门——
> 它的 agent 会话几乎都是短任务单轮，照搬长会话框架是过度工程（见文末"不做清单"）。

---

## 0. harness 的 token 消耗面盘点（钱花在哪）

| 调用点 | 模型 | 频次 | 特征 |
|---|---|---|---|
| 小助理 LLM 兜底（feishu-task-assistant） | ksyun-deepseek-v4.1-flash | 每条未命中消息 1 次 | system ~800 字静态 + RSI 召回块（动态）+ 16 轮窗口；推理型（思考吃输出预算） |
| 复核放行闸门（runReleaseGate） | LLM_MODEL=qwen-turbo | 每次放行 1 次 | 提示词来自 YAML，稳定 |
| task-pipeline digest 摘要 | TASK_PIPELINE_MODEL / LLM_MODEL | 每轮流水线 | 候选池大时上下文长 |
| team-memory 晨报 08:30 / 日报 18:30 | REPORT_SUMMARY_MODEL=qwen-turbo | 每日 2 次 | 定时长上下文摘要 |
| pi 编码工人（@action/pi-agent） | harness-gateway/* | 按派发 | pi 自管上下文（--print 单轮临态） |
| doc-worker | —（非 LLM） | 按派发 | 确定性渲染，零 token ✓ |

---

## M1 · 兜底消息重排吃前缀缓存 ⭐ 当天见效，改动 ~10 行

**问题（实测推演）**：现行 `generateFallbackReply` 把 RSI 召回块**拼进 system prompt 尾部**——
每条消息召回内容不同 → 整个前缀每条都变 → ksyun-deepseek-v4.1 实测 90% 的前缀缓存命中能力
（2600 字前缀二次命中 1536/1699）**完全用不上**。每条兜底 ~2000 prompt tokens 全价。

**改法**（对齐合订版铁律「不改前缀 / 追加而非改写」）：messages 重排为
`[system(纯静态), ...历史窗口, system(召回块), user(当前消息)]`。
- 静态 system 全仓不变 → 首段命中缓存；
- 短时窗口本就是 append-only（300 字 × 16 轮 × TTL 2h）→ 中间轮部分命中；
- 动态召回挪到尾部 → 只有召回块 + 当前消息是增量。
- 预计每条兜底输入费用降 60-80%。

**验收**：同一会话连发两条，比对网关 usage 的 `cached_tokens`（探针脚本见秘籍）。

## M2 · 定时摘要挂本机 qwen3.5 免费资源 ⭐ 零成本

team-memory 晨报 08:30 / 日报 18:30 现走 qwen-turbo 云端计费。本机 qwen3.5 有
**免费常驻窗口**（10:00-11:00 / 15:00-16:00，systemd timer 预热，keep_alive 150m 钉住，
网关条目 `qwen3.5` 走原生协议实测出正文正常——见 local-qwen3.5-access-notes）。

- **日报 18:30 移到 15:30**（窗口内，显存已预热）+ `REPORT_SUMMARY_MODEL=qwen3.5` → 零成本。
- 晨报 08:30 在窗口外：保持云端（质量优先），或接受窗口外按需加载（~30s 冷启动，批量任务可忍）。
- 兜底链末位本就是 qwen3.5（云端全挂时应急），已就绪。

**注意**：别动 litellm config 第 8 行的 `ollama/` 前缀——那是该链路的协议活性单点
（换成 /v1 写法会 200 但零正文，见 access-notes §3）。

## M3 · max_tokens 钳制扩全模型（事故教训制度化）

合订版事故复盘第一条：早报 6 天连败 = qwen-turbo max_tokens 超上游上限，400 → 误判 → 重试。
现网关 `max_tokens_clamp` 只覆盖 qwen 系。扩展到 ksyun / dashscope / bigmodel 各条目，
按各上游实际上限设 cap；推理型模型（思考计入预算）统一抬高下限至 1500。

## M4 · LiteLLM 响应缓存（合订版点名的"大漏"）

`litellm_settings.cache: true` 一个开关：对**参数完全一致**的重复请求直接命中
（定时任务重试、同题判定、幂等探针）。与对话前缀缓存互补，不会污染多轮会话。

## M5 · 计费可见性（没度量就没优化）

- spend log 静默不写：迁移基线已修（142 条 applied，启动报错清零），剩余为 litellm 版本行为，需 `--detailed_debug` 专查。
- `spend` 恒 0：给网关自定义模型补 `model_info` 价格（等金山云报价 + 智谱/硅基流动公开价）。
- 修好后 `cache_hit` + `spend` 两列就是"每天省了多少钱"的直接证据。

## M6 · 纪律写进 AGENTS.md（零改动）

工人（pi / codex / zcode）与未来 pi extension 共享的行为约束进 AGENTS.md：
grep 优先于整读、read 带 offset/limit、并行只读探查、大输出落盘再搜、
**不改写稳定前缀**（尤其 pi extension 注册的工具描述——每轮都进 prompt）。

---

## 落地顺序与工作量

| 序 | 机制 | 改动量 | 预期收益 |
|---|---|---|---|
| 1 | M1 兜底重排 | ~10 行 + 单测 | 每条兜底输入费 -60~80% |
| 2 | M2 日报移窗 + 换模型 | 2 行配置 | 每日 2 次摘要零成本 |
| 3 | M4 响应缓存 | 1 行配置 | 重复请求立省 |
| 4 | M3 钳制扩面 | 网关回调 ~20 行 | 杜绝 400 重试烧钱 |
| 5 | M5 计费可见 | 调查 + 配置 | 度量闭环 |
| 6 | M6 AGENTS.md | 文档 | 行为层长期收益 |

## 明确不做（避免过度工程）

- **不自建 spill / pruner / compaction 框架**：DSH 四道闸门是给"长会话 IDE 型 agent"设计的；
  harness 的会话几乎都是短任务单轮（小助理单条回复、doc-worker 确定性渲染、digest 一次性摘要），
  历史膨胀问题已被短时窗口（16 轮封顶 + TTL）管住。
- **兜底消息不做整段压缩**：窗口封顶永不膨胀，压缩无对象。
- **子代理分流框架**：harness 无 IDE 型长会话，无分流对象；M6 的纪律已覆盖探索行为。
- **qwen3.5 扛 agent 主力**：合订版反面教材（65k 顶格 + 疯狂压缩 + 质量差）——只做摘要/兜底。
