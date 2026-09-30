# timem-team-registry.schema.md — 人员对齐登记表格式

`config/timem-team-registry.json` 的格式说明（本文件被该 JSON 的 `$schema` 字段引用）。

## 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | 格式版本，当前 2 |
| `updated_at` | string (ISO 8601) | 最后写回时间（每次保存自动刷新） |
| `notes` | string[] | 维护说明 |
| `members` | Member[] | 成员条目（`member_id` 为主键，不允许重复） |

## Member 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `member_id` | ✓ | 稳定英文短横线 id（如 `member-johnny`），不用中文 |
| `name` | ✓ | 显示名 |
| `aliases` | ✓ | 别名数组（中文名/英文名/花名/拼音/IM 显示名），自然语言查询参与匹配 |
| `timem_user_ids` | ✓ | 太忆云 user_id（`space_uuid` 格式），可多个；**个人任务快照的 timem user_id 取 `[0]`，缺失时回退 `member_id`** |
| `feishu_open_ids` | ✓ | 飞书 open_id（`ou_` 开头），可多个（一人多机器人场景） |
| `gitea_usernames` | ✓ | git.aigility.cloud 用户名（login），可多个 |
| `match_source` | ✓ | 各身份轴的绑定来源：`{ feishu?: "manual"\|"auto", gitea?: "manual"\|"auto", timem?: "manual"\|"auto" }`；自动匹配永不覆盖 `manual` 绑定 |
| `role` / `team` / `email` / `notes` |  | 可选描述字段 |

## 维护方式

- **人工**：智悦平台「身份对齐」页（`/api/aigility/identity/*`）绑定/解绑/确认，写回本文件并标记 `manual`。
- **自动匹配**：平台页一键运行（`POST /api/aigility/identity/auto-match`），候选来自 Gitea 组织成员 + 飞书通讯录，命中写为 `auto` 待人工确认。
- **发现未登记 timem 账号**：`pnpm --filter team-memory-console cli unknown`。

## 消费方

- `examples/team-memory-console/src/registry.ts`（timem 轴解析/绑定，v1 起就是这个文件）
- `packages/layer-orchestration/src/identity-registry.ts`（三轴解析 + 自动重载，项目小助理 briefing 用）
- `examples/aigility-platform/src/identity-manager.ts`（自动匹配 + 审查页后端）
