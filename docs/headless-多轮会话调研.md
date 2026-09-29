# dsh headless 多轮会话 — 现成方案调研（仅调研，不实施）

> 背景：IM 中继（wecom-dsh / feishu-dsh）目前用「滚动上下文注入」实现多轮：
> 每轮把 ≤12 轮历史拼进任务文本重发。问题：历史重复计费、与 `$DSH_HOME/sessions/`
> 落盘会话两套真相、长对话失真。本文档记录 2026-09 针对 dsh@0.1.5-rc.2 的源码调研结论。

## 结论速览

| 通道 | 多轮支持 | 可用性 |
| --- | --- | --- |
| `dsh --profile headless` CLI | ❌ 每次新建 `session-<uuid>`，无 `--resume` 旗标（`--help` 仅 `-h`/task） | 现状 |
| `dsh --profile tui/web --resume <session>` | ✅ CLI 旗标存在，但仅 tui/web 应用 | 不适合服务端中继 |
| `@deepseek-ai/dsh-agent` SDK | ✅ `AgentRegistry.resume({resumeSessionId})`：「Load a persisted session and resume an agent on it」 | **推荐方向** |
| `@deepseek-ai/dsh-acp` | ✅ `AcpSession.resume(ctx, ResumeAcpSessionOptions)`，协议级会话恢复 | 备选（进程外协议） |

## 源码依据

1. **headless 为什么不能续**：`dsh-headless/lib/index.js` 的 `run()` 硬编码
   `sessionId: brandString(\`session-${randomUUID()}\`)`，跑完 `sessions.flush(agent.session)`
   后 `io.exit()`——会话**已持久化**，只是进程不回头。
2. **SDK 有现成恢复原语**：`dsh-agent/lib/types/index.d.ts`:
   - `AgentRegistry.resume(ownerCtx, options: ResumeAgentOptions): Promise<AgentHandle>`（L185）
   - `ResumeAgentOptions.resumeSessionId: SessionId`（L112）
   - 注释明确「Load a persisted session and resume an agent on it through the registered factory」。
3. **ACP 也有**：`dsh-acp/lib/types/session.d.ts`: `static resume(ctx, ResumeAcpSessionOptions)`，
   fresh/resumed 共享构造输入——若走进程外（中继与 agent 分离部署），这是协议层现成方案。

## 若实施，两条路径

### A. 进程内 SDK（推荐，贴合现有 dsh-interop 定位）
- dsh-interop 已是「唯一允许依赖 dsh suite」的包，且 kernel-dsh 已挂 SDK 服务图；
  新增 `dshAgentResume(dshHome, sessionId, task)`：进程内组装 headless 同款
  profile（或 `--dump-config` 复刻），用 `agents.resume({resumeSessionId})` 代替
  `create` + 随机 sessionId，followup 一条用户消息、取增量回复。
- TranscriptStore 退化为「chatId → sessionId 映射」，不再搬运文本；
  `/new` = 丢弃映射；历史真实性 100%，token 只算增量。

### B. ACP 协议通道
- 中继 ↔ 常驻 dsh ACP server（`dsh-acp-app`），按 `session/resume` 恢复。
- 优点：agent 常驻、无每次冷启动；代价：多一个常驻进程与协议层。

## 风险与注意

- resume 语义需验证：恢复后的 agent 是否重放完整上下文、工具授权/沙箱状态是否重建
  （建议先做一个 spike：headless 跑一轮 → 记下 sessionId → SDK resume 续问，验证记忆连贯）。
- 版本锚定：以上 API 均在 0.1.5-rc.2 考证；升级 dsh 需回归。
- 会话归属：resume 的会话落在 `DSH_HOME/sessions/<工作区 munge>/`，中继的
  `DSH_CWD` 必须稳定，否则 GUI 侧看不到会话。

## 决定

暂不实施。当前滚动注入在 ≤12 轮、6000 字符上限下够用；待真实使用中出现
token 成本或记忆质量问题，按路径 A 启动 spike。
