# project-registry.schema.md — 项目对齐登记表格式

`config/project-registry.json` 的格式说明（本文件被该 JSON 的 `$schema` 字段引用）。

目标：**同一个项目在飞书群、飞书任务清单、Gitea 仓库、运维日志中是同一个项目**。

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | 格式版本，当前 1 |
| `updated_at` | string (ISO 8601) | 最后写回时间 |
| `notes` | string[] | 维护说明 |
| `projects` | Project[] | 项目条目（`project_id` 为主键） |

## Project 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `project_id` | ✓ | 稳定英文短横线 id；**项目级 timem 记忆的虚拟用户键为 `project:<project_id>`** |
| `name` | ✓ | 显示名 |
| `aliases` |  | 自然语言查询别名（如「nx」「太忆」） |
| `gitea_repos` |  | `org/仓库` full_name 数组 |
| `gitea_orgs` |  | 整组织项目（briefing 时经 `/orgs/{org}/repos` 动态展开） |
| `feishu_chat_ids` |  | 项目群 chatId（`oc_` 开头） |
| `log_sources` |  | log-monitor 监控项 `{host, p, s}`（p=项目键，s=服务名；host 为 log-monitor 拉取的日志服务地址） |

飞书任务清单不单独登记：沿用既有约定「一个 Gitea 组织 = 一个任务清单」（`tasklistNameForRepo`），
任务标题 `[org/repo#N]` 前缀可反查仓库归属。

## 消费方

- `packages/layer-orchestration/src/project-registry.ts`（加载 + 按 chat/repo/名称解析，30s 自动重载）
- `packages/layer-orchestration/src/project-briefing.ts`（多源汇总 / 定期快照）
