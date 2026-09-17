# wecom-dsh — 在企业微信上与 harness agent 对话

企微消息 → `wecom-ingress` → `@infrastructure/dsh-session-relay` → 官方
`dsh --profile headless [--resume <sessionId>]` CLI。

- agent 能力 = 官方组合器装配的完整服务图（llm / tools / session / 沙箱 / skill）
- 多轮记忆 = 官方 session 存储（`--resume` 续聊同一会话）
- 与 Web GUI 共用 `DSH_HOME` + 工作区时，企微产生的会话会出现在 GUI 的会话历史里

## 配置（本目录 `.env`，模板 `.env.example`）

> 配置放**本目录**的 `.env`（gitignored），而不是仓库根。原因：官方 dsh 的 `readEnvLayer` 安全检查禁止**工作区方向**的 `.env` 文件出现保留变量名（`DSH_BIN`/`DSH_HOME`/`DEEPSEEK_BASE_URL` 等，只允许环境变量注入），而 dsh 子进程工作目录是仓库根；本目录在 dsh 的加载范围之外，因此可以直接用 dsh 的原生变量名，无需别名转换。详见 `docs/启动与部署指南.md` 坑 9。

```ini
# 企微「智能机器人」凭证（企微管理后台创建）
WECOM_DSH_BOT_ID=xxx
WECOM_DSH_BOT_SECRET=xxx

# 官方 dsh CLI 入口（bin.dsh 指向的 lib/bin.js 绝对路径）
# 真实路径用 node -e "console.log(require.resolve('@deepseek-ai/dsh/package.json'))" 查，bin.js 在同目录 lib\bin.js
DSH_BIN=D:\SiteWorkspace\aigility-harness\node_modules\.pnpm\@deepseek-ai+dsh@0.1.5-rc.2_<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js

# DSH 家目录（sessions/profiles 所在；与 GUI 共用即可互通会话历史）
DSH_HOME=D:\SiteWorkspace\aigility-harness\examples\.dsh-home

# agent 工作区（决定会话归属的工作区 key；默认本仓库根）
# DSH_CWD=E:\AI\aigility-harness

# headless 上游（OpenAI 兼容；直连或指向网关）
DEEPSEEK_API_KEY=xxx
DEEPSEEK_BASE_URL=https://open.bigmodel.cn/api/paas/v4
# DSH_PERMISSION_MODE=read-only
```

> 提示：`DSH_BIN` 的完整路径可在 runtime 侧用
> `node -e "console.log(require.resolve('@deepseek-ai/dsh/package.json'))"` 找到，
> bin.js 在同目录 `lib/bin.js`。
>
> 排障建议：企微链路报错时先绕开企微直接验证 dsh——
> `$env:DSH_HOME=...; node <bin.js> --profile headless "回复ok"`；
> 报 `readEnvLayer`/`which only the launching environment may set` 即为坑 9（.env 保留变量），见上。

## 运行

```bash
pnpm --filter wecom-dsh start
# 企微里 @机器人 说话 → agent 干活 → 结果回企微（Markdown）
```

## 企微指令

| 指令 | 行为 |
|------|------|
| 普通消息 | 转发给 agent（同一会话多轮续聊） |
| `/new` | 放弃当前会话，下条消息开新会话 |
| `/session` | 查看当前绑定的会话 id |

## 说明与边界

- 会话 id 自动发现：首条消息后扫描 `$DSH_HOME/sessions/**/session-*` 的新增目录；
  chatid → sessionId 映射持久化在 `.state/sessions.json`。
- 每条消息是一次独立 headless 进程：**重型工具调用可用，但进程内状态不跨消息保留**
  （跨消息记忆靠 session 存储与工作区文件）。
- agent 跑任务可能较久（默认超时 300s）；企微侧会先收到「🤖 agent 正在处理…」占位。
- 与 GUI 正打开的同一个会话**不建议**用 `--resume` 并发写（会话文件并发写入有风险）；
  本示例默认为企微新建独立会话线程。
