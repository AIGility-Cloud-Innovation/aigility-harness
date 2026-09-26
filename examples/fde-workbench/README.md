# TiMEM FDE 工作台（fde-workbench）

面向 FDE（Forward Deployed Engineer）的交付一体化工作台示例：线索、方案、合同、交付、部署、渠道、知识沉淀、续费台账全流程，**深度接入 aigility-harness 五域架构**。

前端由 Kimi Agent（FDE 工作台）生成，收编进仓库后完成 harness 深度整合。

## 全功能形态（平台账号 + PG 持久化）

工作台**不是纯前端演示**：登录为真实平台账号（复用 AppBase `users` 表，scrypt + HMAC token + 登录限流，与 AppBase 账号互通），业务台账持久化到 PostgreSQL（复用 `/app/data` 应用共享 JSONB 原语，`app:fde-workbench` 虚拟 owner，19 个分片），任何变更 700ms 内自动落库；行动指令确认后即写库；LLM 用量经网关上报 `llm_usage` 表按 key 归集。PG 缺省连 `127.0.0.1:5433/appbase`（`APPBASE_PG_*` 可覆盖），与 AppBase 共库即共账号。

## 一键启动

```bash
# 仓库根目录
pnpm install
pnpm example:fde
```

或 Windows 双击 `start-fde-workbench.cmd`（从 `.example` 复制并填 `BIGMODEL_API_KEY`）。

就绪后：

| 入口 | 地址 | 说明 |
|---|---|---|
| 工作台前端 | <http://127.0.0.1:1234/> | 打开即用，对话走同源会话代理（网关主密钥仅服务端持有，不注入前端） |
| AI 网关 | <http://127.0.0.1:1235/v1/chat/completions> | OpenAI 兼容，Bearer 鉴权，密钥启动时打印 |
| 数字员工问答 | `POST :1235/api/fde-chat` | → `@persona/fde-assistant` |
| 文档工人 | `POST :1235/api/fde-doc` | → `@action/doc-worker` |

演示账号：`admin/admin123`、`zhaopeng/fde123`、`chensiyuan/fde123`（角色视角不同）。

## 深度整合链路（五域全走 Seam）

```
数字员工开放问答（逐字流式）
  前端 EmployeePanel
    └─ POST /api/fde-chat {user_input, history, business_context, user_key, stream:true}
        └─ D1 http-ingress ──路由──→ D5 @persona/fde-assistant（人设 + 业务快照注入 system prompt）
             └─ D4 @orchestration/workflow-engine（TiMEM 记忆召回 → LLM → 沉淀，agent_id=fde-assistant）
                  └─ D2 @cognitive/llm-inference（bigmodel / litellm / stub 降级）
             ← OpenAI 兼容 SSE 帧（网关编码，前端逐字渲染）

方案 Word 导出（文档工人）
  前端 ProposalDetail「导出 DOCX」
    └─ POST /api/fde-doc {title, subtitle, blocks[]}
        └─ D3 @action/doc-worker（结构化块 → 服务端 docx 确定性渲染，base64 回传下载）
             ← 产出回工作台仍需人工确认，人在回路不变
```

- **行动类指令**（推进线索/创建提醒/生成方案）由前端本地识别 + 行动卡片人工确认后执行，不进模型 —— 人机分工原则。
- **业务上下文**：前端把线索/方案/合同/交付/续费/待办台账快照随请求注入（`buildBusinessContext`），persona 层拼进 system prompt；LLM 只答台账里有据可查的内容。
- **记忆**：按工作台登录账号隔离（`agent_id=fde-assistant`），召回/沉淀是 workflow-engine 流内标准节点，未配置 TiMEM 时静默跳过。
- **LLM 上游**：`BIGMODEL_API_KEY` → bigmodel；`LITELLM_URL/KEY` → litellm；都缺省 → stub 降级（链路仍通，回复带【服务降级】标记）。

## 架构图

完整架构图（前端 / 服务端装配 / 五域两条 Seam 链路 / 人在回路 / TiMEM 记忆 / LLM 上游）：
服务启动后打开 <http://127.0.0.1:1234/architecture.html>，源文件为自包含 SVG 页 [`app/public/architecture.html`](app/public/architecture.html)。

## 目录结构

```
fde-workbench/
├── app/               # 前端源码（React 19 + Vite 7 + Tailwind 3 + shadcn/ui）
│   ├── public/architecture.html  # 完整架构图（自包含 SVG，构建后 /architecture.html 访问）
│   └── src/
│       ├── lib/harness.ts       # 网关客户端：SSE 泵 + fde-assistant/doc-worker 调用
│       ├── lib/proposalDoc.ts   # 方案 → 文档工人块结构映射
│       ├── store/AppContext.tsx # 业务状态 + 业务快照组装 + 问答链路
│       └── ...
├── src/index.ts       # 服务端装配：内存内核 + 五域插件 + 网关 + 静态托管
└── src/defaults.ts    # LLM 上游按环境自动选择（先于 layer-* 求值）
```

## 配置（环境变量）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `BIGMODEL_API_KEY` | — | 智谱开放平台 Key（配置即真实推理） |
| `BIGMODEL_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | bigmodel 兼容上游地址 |
| `LITELLM_URL` / `LITELLM_KEY` | — | LiteLLM 网关（未配 bigmodel 时生效） |
| `LLM_PROVIDER` | 按上述自动 | 显式覆盖：`bigmodel` / `litellm` / `stub` |
| `LLM_MODEL` | `glm-4.6` | workflow-engine 默认模型 |
| `FDE_WEB_PORT` | `1234` | 工作台前端端口 |
| `FDE_GATEWAY_PORT` | `1235` | AI 网关端口 |
| `APPBASE_PG_HOST/PORT/DATABASE/USER/PASSWORD` | `127.0.0.1:5433/appbase` | 平台 PG（账号+台账持久化） |
| `FDE_PUBLIC_HOST` | `127.0.0.1` | （已废弃，不再使用；网关密钥不再下发前端） |
| `DOC_WORKER_DIR` | 系统临时目录 | 文档工人落盘目录（同时 base64 回传前端下载） |
| `TIMEM_API_KEY` / `TIMEM_BASE_URL` | — | TiMEM 记忆云（未配置时记忆节点静默跳过） |

## 与框架的改动点（本示例落地时新增的框架能力）

- `@persona/fde-assistant`（`packages/layer-persona/src/fde-assistant.ts`）：FDE 数字员工角色，业务快照注入 + 记忆节点下沉编排域。
- `@action/doc-worker`（`packages/layer-action/src/doc-worker.ts`）：D5 文档工人，结构化块 JSON → 服务端 docx（`docx` npm 库确定性渲染，非 LLM 生成文件内容）。
- http-ingress agent 链路支持 `stream:true`：角色回复编码为 OpenAI 兼容 SSE（`packages/layer-infrastructure/src/http-ingress.ts`）。
