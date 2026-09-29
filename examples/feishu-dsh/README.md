# feishu-dsh — 飞书机器人 → DSH headless 会话中继

在飞书上与 harness agent（官方 dsh headless，与 Web GUI 同一套 llm/tools/session/沙箱）对话。

> 核心逻辑（多轮记忆 / headless 调用 / 指令 / 截断）在共享包
> `@aigility-harness/dsh-interop` 的 session-relay（`packages/dsh-interop/src/session-relay.ts`），
> 本目录只是飞书侧薄装配。wecom-dsh 复用同一实现。

## ⚠️ 机器人身份归属

`cli_a9e24e913a39dcd6` 是「项目小助理」（`examples/feishu-task-loop`）的应用，
**不要配置给本装配**——一个 appId 只能挂一条飞书长连接，混用会把小助理踢下线。
DSH 请使用独立的飞书应用（开放平台：开机器人能力 + 长连接订阅 + `im:message` 权限 + 发版）。

## 准备

`examples/feishu-dsh/.env`（**DSH 专用应用的凭据**；本文件 gitignore，凭据不进仓库）：

```
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
# 以下可选（有合理缺省）
# DSH_HOME=~/.dsh
# DSH_CWD=仓库根
```

本文件先于仓库根 `.env` 加载且先到先得：只影响本装配，不会覆盖/污染小助理读的根 `.env` 凭据。

## 启动

```
pnpm install          # 首次：链接新 workspace 包
pnpm --filter feishu-dsh start
```

## 使用

- 私聊机器人直接说话；群里需 @机器人
- `/new` 清空当前聊天上下文；`/session` 查看保留轮数
- 多轮记忆由共享 TranscriptStore 滚动上下文注入，历史落盘 `.state/transcripts.json`（已 gitignore）
