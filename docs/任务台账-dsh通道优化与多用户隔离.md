# 任务台账：DSH 飞书通道优化 + 多用户隔离（写文档）

> 建立于 2026-10-27。本台账只含 **1 个任务**，交付物为一份设计文档，覆盖「通道优化」与「多用户隔离」两章。
> 触发背景：飞书 DSH 于 2026-10-27 连续报 `UNKNOWN: Cannot read properties of undefined (reading 'prepare')`，排查中同时暴露通道结构与多租户缺口。

## 一、台账

| 编号 | 类型 | 标题 | 状态 | 负责 | 优先级 | 产出 |
|---|---|---|---|---|---|---|
| T-DOC-001 | 文档 | DSH 飞书通道优化 + 多用户隔离设计 | 待开始 | 待指派（Hermes 出稿 / 用户指定执行者落地） | P1 | `docs/dsh-feishu-channel-and-multitenant.md` |

**验收标准**

1. 两章齐全：`二 通道优化`、`四 多用户隔离`，各自含「现状事实 / 问题 / 方案对比 / 推荐 / 工作量」。
2. 每条现状结论都引用可复现的证据（命令、日志行、代码路径），不写推测。
3. 方案给出 A/B 对比表 + 明确推荐，且标注「需要改哪些文件、影响哪些进程」。
4. 多用户隔离给出可执行的分阶段路径（P0 最小隔离 → P2 容器级），每阶段有验收用例（两个 open_id 并发提问，互不可见）。
5. 文档不进 `.env` 明文、不含 API Key。

## 二、章节骨架（已核实的现状事实可直接引用）

### 第 2 章 通道优化

**已核实事实**

- 长连接层 **不是自研**：`examples/feishu-dsh/src/index.ts` 用的是 `layer-infrastructure` 的 `feishuIngressProvider`，与 `feishu-task-loop` 同一套通用 ingress（App ID → 人格路由）。
- 自研部分是 **会话层** `packages/dsh-interop/src/session-relay.ts`：
  - 每来一条消息 spawn 一次 `dsh --profile headless`（`dshRunCli`），无长驻会话；
  - 历史按 `chatId` 落 `TranscriptStore`（当前滚动 12 轮），每轮以纯文本「以下是此前的对话记录」注入 prompt；
  - 收完 stdout 才回帖，无流式；靠 `DSH_RELAY_TIMEOUT_MS`（30 分钟 idle watchdog）兜底；
  - 失败时把底层错误原文透传（本次即 `TypeError` 文本直接进飞书）。

**问题清单（按影响排序）**

| # | 问题 | 可观测代价 | 建议 |
|---|---|---|---|
| 1 | 每条消息起进程 + 文本回放历史 | 启动 ~2s；token 随轮数线性增长；工具/会话状态不连续 | 每 chat 常驻会话，或按会话 `--resume` |
| 2 | 无流式 | 长任务在飞书里表现为「没反应」，只能等 watchdog | 卡片增量更新 |
| 3 | 错误原文透传 | 用户看到 `TypeError`，无法自助判断 | 错误分类 + 人话映射 + 可重试标记 |
| 4 | 版本无钉扎/无自检 | rc.3 回归直接打挂线上，排查耗时 | 固定版本 + 启动自检（见第 5 节复盘） |
| 5 | 并发无队列 | 同一 workspace 多进程互抢 | 每租户串行队列 + 全局并发上限 |

**方案对比（写文档时展开）**

| 方案 | 会话连续性 | 流式 | 稳定性风险 | 工作量 |
|---|---|---|---|---|
| 现状：spawn + 文本回放 | 无 | 无 | 低 | — |
| A. 常驻 CLI 会话（按 chat 保活进程） | 有 | 需改造 | 中（进程管理/回收） | 中 |
| B. 接 DSH 内部 API（`dsh web` :3080 / `api/remote.mux`） | 有 | 原生 | 高（内部 RPC、跨 rc 版本漂移） | 大 |

推荐：**A 先行**，B 待 rc 线稳定后再评估；两者都保留现有 ingress 不动。

### 第 4 章 多用户隔离

**硬约束（已核实）**

- DSH 的 `cwd` 是进程级单值；headless 每次执行是新会话 ⇒ DSH 自身不具备多租户能力。
- 现状 `session-relay` 中 `cwd` 与 `DSH_HOME` 都是全局的，`chatId` 仅用于分历史与角色 ⇒ 两个用户会共享工作目录、会话目录、`patch-<role>.yml`。

**分阶段方案**

| 阶段 | 做法 | 隔离维度 | 改动点 | 验收 |
|---|---|---|---|---|
| P0 | 按 `open_id` 派生 `DSH_HOME/tenants/<id>` + `workspace/tenants/<id>`，relay 逐次传入 | 会话/文件/人设 | `session-relay.ts` 两处取值 | 两账号各自的 `AGENTS-*.md`、文件互不可见 |
| P1 | 每租户串行队列（同人同时 1 轮）+ 全局并发 2–3 | 并发/资源 | relay 增加队列 | 并发提问不串话、不抢文件 |
| P1 | 权限分档：外部用户禁 `danger-full-access`，工具白名单 | 权限/越权 | 角色注册表 | 越权命令被拒并有提示 |
| P2 | 每租户容器/WSL，只挂自身 workspace | 全隔离 | 部署层 | 跨租户不可见、可独立限额 |

**不建议**：单 `DSH_HOME` + 不同 role 名硬隔 —— `AGENTS-<role>.md` 虽分开，会话目录、文件写入、并发仍共享。

## 三、第 5 节（复盘素材，已发生的事实）

2026-10-27 故障链，可整段引用：

1. 现象：飞书发消息 → `⚠️ agent 执行失败 (5s): dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')`。
2. 定位：纯聊天正常、任何工具调用必挂；`DSH_HOME` 换全新目录仍复现 ⇒ 与 profile/会话无关。
3. A/B：`@deepseek-ai/dsh@0.2.0-rc.2` 正常；`0.2.1-rc.3` 失败；干净环境单装 `0.2.1-rc.4` 正常。
4. 真因（仓库树内）：`@deepseek-ai/cordis` 同时存在 `4.0.4` 与 `4.0.5` 两个实例（9 个模块走 4.0.4，131 个走 4.0.5）⇒ 服务注册表分裂，`scheduler` 取不到 ⇒ `.prepare` undefined。
5. 修复：`pnpm-workspace.yaml` 增加 `overrides` 固定 `cordis@4.0.5` + `cordis-plugin-include@1.0.10` + `cordis-plugin-loader@1.0.6`；`packages/dsh-interop/package.json` 四个 DSH 包 `0.2.1-rc.3 → 0.2.1-rc.4`；复验 bash 工具输出 `rc4-final-ok`。
6. 启示（写进文档第 2 章 #4）：**DSH 版本升级必须验「带工具调用」，不能只验聊天**；单一依赖实例是硬约束。

## 四、待决策

1. 文档落到哪个仓/知识库（本仓 `docs/` / aici-wiki）。
2. 是否同步建 PingCode 工单（当前仅本文档台账，未建外部工单）。
3. T-DOC-001 的负责人（Hermes 出稿，还是派给 agent）。
