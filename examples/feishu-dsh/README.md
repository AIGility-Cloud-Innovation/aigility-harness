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

## 角色能力注册表（可选）

`roles.json` 是本地环境配置（含本机绝对路径与 MCP 密钥），**已 gitignore，不入库**。
首次使用从模板复制：

```
cp examples/feishu-dsh/roles.example.json examples/feishu-dsh/roles.json
# 然后填入本机路径与密钥
```

注册表把渠道身份映射成角色（`skills` + `mcpServers`），每条消息热读取，改完即生效；
但 MCP 客户端在会话启动时注入，**新增/修改 mcpServers 后需重启本装配**。

### timem（太忆空间长期记忆）

`mcpServers` 里的 `timem` 提供 `search_memories` / `create_memory` / `delete_memory` 等工具。

- 地址用 **`https://test.space.timem.cloud/mcp/`**（**尾斜杠必须有**）。
  本仓库处于开发验证期，**以 Space 测试服为主要在线服务**。
- ⚠️ 认证头必须是 **`X-API-Key`**（不是 `Authorization: Bearer`）。
  用错头时服务端只回一个笼统 401，**不能据此判定端点不存在**。
- `X-API-Key` 用 **Space 密钥（`tmk_` 开头）**——团队成员建自己的工作记忆。
- ⚠️ 与 `timem.cloud` 正式服的 REST 密钥（`sk-` 开头，团队负责人管理团队记忆）**不通用**：
  `tmk_` 打 REST 报 401，`sk-` 打 Space MCP 报 401。
- 测试服与 `api.space.timem.cloud` 是**两套独立部署**，密钥各自有效、不可混用。
- ⚠️ 网页路由与 MCP 路径不同：`/mcp`（无尾斜杠）是**网页路由**，会返回 Next.js 404，
  别拿它当"MCP 不存在"的证据。

## 启动

```
pnpm install          # 首次：链接新 workspace 包
pnpm --filter feishu-dsh start
```

## 使用

- 私聊机器人直接说话；群里需 @机器人
- `/new` 清空当前聊天上下文；`/session` 查看保留轮数
- 多轮记忆由共享 TranscriptStore 滚动上下文注入，历史落盘 `.state/transcripts.json`（已 gitignore）
