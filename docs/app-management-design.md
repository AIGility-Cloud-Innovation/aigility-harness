# 应用管理与 LLM 用量监控设计

> 状态：账号/API Key 管理**已实现**；用量监控**数据链路已就绪，展示 UI 待实现**。

## 1. 模型

```
应用大厅 (hall)
 ├── 应用 = examples/apps/*.html (沙箱自包含 HTML) → 首次管理时自动注册进 apps 表
 ├── 每应用可登录账号   → app_accounts (username + scrypt 密码, 按 app 隔离)
 ├── 每应用 API Key     → app_keys (sk-app-*, 可吊销, 可绑定到账号)
 └── LLM 用量          → llm_usage (按 Key 归集, 可映射到账号)
```

- 应用打开时，大厅通过 `GET /app/hall/key?app=<名>` 取该应用的默认 Key，
  并以 URL hash（`#gw=<key>`）注入；应用启动时读 hash 写入本地配置。
  **用户不需要在应用内手动配置 API Key。**
- 网关鉴权：master key（`APPBASE_GATEWAY_KEY`）或任一未吊销的应用 Key 均可通过
  （`isKnownGatewayKey`，30s 内存缓存）。

## 2. 已实现的接口

| 接口 | 说明 |
|---|---|
| `GET /app/hall/apps` | 列出沙箱应用 |
| `GET /app/hall/apps/:name` | 打开应用（返回 HTML） |
| `GET /app/hall/key?app=` | 取/签发应用默认 Key（需登录） |
| `GET /app/hall/manage?app=` | 账号 + Key + 用量数据（需登录，应用归属者） |
| `POST/DELETE /app/hall/manage/account[/:id]` | 应用账号增删 |
| `POST/DELETE /app/hall/manage/key[/:id]` | 签发/吊销 Key |
| `POST /app/usage/collect` | 网关用量上报（内部，master key 鉴权） |

## 3. 用量监控数据链路（已就绪）

1. **上报点**：`http-ingress.ts` dev 链路（`/v1/chat/completions` 等）LLM 调用成功后，
   若配置 `usageReportUrl`，fire-and-forget `POST {key, model, usage}`。
   appbase 启动时已传入 `http://127.0.0.1:3419/app/usage/collect`。
2. **存储**：`llm_usage` 表（key / model / prompt_tokens / completion_tokens / total_tokens / created_at）。
3. **聚合查询**：`GET /app/hall/manage` 已返回 `usage`（最近 100 条明细）和 `agg`
   （按账号/Key 聚合的调用次数与 token 总数）。

## 4. 待实现（UI 层）

- [ ] 大厅管理抽屉的"用量"标签页：明细表 + 按账号聚合视图（数据接口已返回 `usage`/`agg`）
- [ ] 按时间范围筛选（日/周/月 token 消耗曲线）
- [ ] 用量告警（单 Key 配额上限，超限返回 429）
- [ ] 流式请求的用量统计（当前流式路径剥掉 stream 后仍可统计——已在同一切入点，仅需确认 SSE 分支也上报）
- [ ] 非内网部署时 `/app/usage/collect` 的鉴权强化

## 5. 已知限制

- 应用账号体系（app_accounts）与 AppBase 登录账号（users）相互独立；应用内登录页需自行对接
  `/app/hall/manage` 颁发的账号（小本本目前用 users 体系，未迁移）。
- 用量归集粒度是 **Key → 账号**；未绑定账号的 Key 用量按 Key 本身归集。
