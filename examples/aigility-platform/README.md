# Aigility 智悦智能平台（aigility-platform）

**Aigility（中文名「智悦」）—— FDE 自用的数字员工智能体平台**：把 aigility-harness 五域引擎封装成可交付客户的数字员工产品壳。前端由 Kimi Agent 生成（智悦智能平台 PRD V1.3 演示站），收编进仓库后完成 harness 深度整合 —— 与 fde-workbench 同一收编剧本。

一句话定位：**aigility-harness 是引擎，Aigility（智悦）是把它包装成可交付产品的封装台**。FDE 在这里完成「配数字员工 → 发布 → 上架 → 对话验证」的封装动作；数据接入/知识图谱/租户计费等重模块当前为产品壳演示（Mock），渐进接真。

## 一键启动

```bash
# 仓库根目录
pnpm install
pnpm example:aigility
```

或 Windows 双击 `start-aigility-platform.cmd`（从 `.example` 复制并填 `BIGMODEL_API_KEY`）。

首次启动需先构建前端：`pnpm --filter @aigility-harness/aigility-platform build`。

就绪后：

| 入口 | 地址 | 说明 |
|---|---|---|
| 平台前端 | <http://127.0.0.1:1236/> | 登录后进入（AppBase 平台账号），对话走同源会话代理（网关主密钥仅服务端持有，不注入前端） |
| AI 网关 | <http://127.0.0.1:1237/v1/chat/completions> | OpenAI 兼容，Bearer 鉴权（app_keys 表持久） |
| 登录/注册/会话 | `POST :1236/app/auth/login\|register\|logout` | AppBase users 表 scrypt + HMAC token + 登录限流 |
| 数字员工对话 | `POST :1237/api/aigility-chat` | → `@persona/aigility-agent`（工厂技能 + 平台管家） |
| 引擎原生角色 | `POST :1237/api/aigility/p/<key>/chat` | → `@persona/<key>`（市场页「已接入」区逐个开路由） |
| 封装 API | `:1236/api/aigility/*` | registry/skills/capabilities/llm/metrics/timem/task-loop/modules/presets/plugins，全部校验 AppBase 会话 |

> 依赖 AppBase PG（缺省 `127.0.0.1:5433/appbase`，`APPBASE_PG_*` 可覆盖；本机原生 PG 用 5432，
> 参考 `examples/appbase/start-appbase.sh`）。首次启动自动建表 + 播种演示账号：
> `admin@aigility.local/admin123`（库非空时不抢管理员）· `fde@aigility.local/fde123` · `demo@aigility.local/demo123`。

## 三条真链路（其余板块见对照表）

```
智能体工厂「发布」（真注册）
  StudioPage 五步向导
    └─ POST /api/aigility/skills → data/aigility-skills.json 持久化（skill-registry）
         → 立即可对话：对话工作台切换 @技能 / 市场页「智能体工厂 · 已发布」上架

数字员工对话（真对话, 逐字流式）
  AgentPage 对话工作台（对话身份：平台管家 / 工厂发布的技能）
    └─ POST /api/aigility-chat {user_input, skill_id, history, stream:true}
        └─ D1 http-ingress ──路由──→ D5 @persona/aigility-agent（示例本地插件, 不改框架包）
             │   skill_id 命中 skill-registry → 按技能装配 system prompt
             └─ D4 @orchestration/workflow-engine（TiMEM 记忆召回 → LLM → 沉淀, agent_id=aigility-skill-<id>）
                  └─ D2 @cognitive/llm-inference（bigmodel / litellm / stub 降级）
             ← OpenAI 兼容 SSE 帧（网关编码, 前端逐字渲染）

引擎原生角色对话（真对话）
  MarketPage「已接入 aigility-harness」区 → 真对话体验
    └─ POST /api/aigility/p/<key>/chat → layer-persona 注册表真实角色
         （fde-assistant / harness-guide / sales-chat / coding-coach / timem-* 等 11 个, 随引擎启动自动枚举）
```

登录鉴权（真, AppBase）：未登录整站门禁只显示登录屏；`/api/aigility/*` 全部校验 AppBase 会话（401 统一清会话回登录屏）；
用户菜单/侧栏显示真实账号身份，退出登录即清会话。token 与 AppBase 全线互通。

MCP 工具总线（真, DSH 家族通道）：
  dsh_plugins 表三行种子: dsh-system-prompt（dsh-tools 依赖同伴）+ dsh-tools（ctx.tools 服务）
                          + dsh-mcp-client（stdio → @modelcontextprotocol/server-everything, npx 首跑拉包）
  链路: 外部 MCP server → @deepseek-ai/dsh-mcp-client → 宿主 ctx.tools（mcp__<server>__<raw>）
        → @action/dsh-tool 桥（list/call, 示例本地插件, 经 appbase dsh-host 工具访问器）
        → Seam → GET/POST /api/aigility/dsh/tools* → 工具插件中心「MCP 工具总线」区块（清单 + 调用测试面板）
  装载全部走 dsh-interop（官方套件唯一落脚点, 三级解析基准 + cordis 实例对齐校验），零直接 import。

四个真数据区块（页面顶部, 均带「真」徽标 + 演示数据明确标注）：
  工具插件中心   GET /api/aigility/capabilities → 内核五域插件 Provider 全量枚举（能力总线）
  模型管理       GET /api/aigility/llm          → D2 实际生效的推理上游（provider/model/上游地址）
  运营驾驶舱     GET /api/aigility/metrics      → 实时指标（角色/技能/对话计数, 15s 轮询）
  TiMEM 空间     GET+POST /api/aigility/timem/* → 连接状态探测 + 记忆检索（Seam → @action/timem-memory）

市场/工作台里的「官方模板库」「12 类智能体」「数据接入→图谱」「租户/权限/计费」等仍为 Mock 演示数据（`app/src/mock/data.ts`），用于产品形态展示，接真节奏见下。

## 项目小助理任务闭环（真 · 托管 feishu-task-loop）

「项目小助理」是飞书侧的任务管理机器人（`examples/feishu-task-loop`，独立子进程，单实例锁守护），平台负责托管与可视化：

- **使用界面 = 任务看板**（左侧导航「项目小助理」→ `TaskLoopBoardPage`）：把 Gitea 工单聚合成三列看板——待派发（open·无执行人）/ 执行中（open·有执行人）/ 已完成（closed），按仓库筛选、30s 自动刷新可暂停，点卡片直达工单。数据源 `GET /api/aigility/task-loop/board`：仓库池 = `TASK_REPOS` ∪ `TASK_CHAT_REPO_MAP`（`org:` 前缀经 `/orgs/{org}/repos` 展开，缓存 5min），复用 `@action/gitea-api` 固化的公共 DNS 绕行 + token 认证，排除 PR，单仓库失败不阻塞其余。
- **配置与运维**（看板页右上角入口 → `TaskLoopConfigPage`）：机器人启动/停止/重启（锁探活 + 僵锁自愈，管理页启动的实例标记「本平台托管」）、飞书接入凭证（页面配置优先于仓库 .env，Secret 只回掩码）、播报群可视化选取、LLM 兜底模型 / 轮询间隔 / featureFlags / 自定义 env（保存后需重启生效）、stdout/stderr 日志 tail。
- **控制权约定**：左侧导航是否显示「项目小助理」由**模块装配页或配置页**的开关控制（同一 `enabledModules` 状态），与应用中心无关；**机器人进程启停**在配置页按钮与**应用中心卡片开关**（真实启停，状态实时查服务端，双向同步）；应用中心其余应用开关仍为货架演示态。
- **闭环链路**：飞书群消息静默汇总 → 识别任务建飞书任务（规划中）→ 「任务归属 / 安排执行者」确认 → 落单 Gitea 工单（进看板）→ 完成后状态回写飞书。机器人本体架构与运行细节见 `docs/feishu-task-loop-architecture-review.md`。

## 页面 ↔ 五域引擎对照（逐模块终版）

原则：五域引擎已有的资源一律真对接；引擎未实现的保持产品壳演示并明确标注「暂不对接」。

| 页面 / 模块 | 处置 | 五域引擎对应资源 |
|---|---|---|
| 登录鉴权（LoginGate/全站门禁/退出） | **真** | AppBase users 表（scrypt+HMAC token+限流）· platform.ts 零新造 |
| 数字员工对话（AgentPage） | **真**（user_key=登录邮箱 → 计量/积分按用户归集） | D1 http-ingress → D5 aigility-agent → D4 workflow-engine → D2 llm-inference |
| 智能体工厂（StudioPage） | **真**：单页五分区（人设 D5 / 模型 D2 / 能力 D3 / 编排 D4 / 通道与发布 D1）+ 左侧粘性目录——模型偏好请求级透传（网关模型池）、编排委托（manifest 声明）、通道声明进发布分区；假配置（模型假下拉/知识库 mock/试运行假日志/草稿）已删除 | 示例本地 LayerPlugin `@persona/aigility-agent` |
| 智能体市场（MarketPage） | **真**：引擎原生角色区（自动枚举）+ 工厂发布区 | D5 layer-persona 注册表 + 网关逐 persona 路由 |
| 工具插件（ToolsPage） | **真**：能力总线（46 Provider）+ MCP 总线（13 工具直调）+ **已安装插件区块**（安装/启停/卸载 = `dsh_plugins` 注册表 + dsh-host 热装卸免重启, 关键件保护, 变更入审计）；演示工具货架 Mock | 内核插件枚举 + DSH `dsh_plugins` + `dsh-mcp-client` → `@action/dsh-tool` 桥 |
| 模型管理（ModelsPage） | **真**：当前推理上游；模型矩阵 Mock | D2 llm-inference 生效配置（litellm/bigmodel） |
| 运营驾驶舱（OpsPage） | **真**：实时指标 + 调用/Token 计量与趋势（usage byDay） | 内存计数 + D1 token-metering summary |
| TiMEM 空间（SpacePage） | **真**：连接状态 + 记忆检索；记忆流/规则/知识库列表 Mock | Seam → `@action/timem-memory`（引擎无知识库/规则服务） |
| 工作台 Token 用量卡 | **真**：按日 Token/调用（随对话实时产生） | D1 token-metering（D2 每次推理自动上报） |
| 工作台积分余额卡 | **真**：credit 账户余额（预检/实扣随对话自动生效） | D1 `@infrastructure/credit`（PgCreditStore） |
| 权限管理·平台成员/审计日志 | **真**：成员清单 + 登录/操作留痕 | AppBase users×app_members + audit_log |
| 应用中心·报告中心 | **真**：结构化块 → docx 下载 | D3 `@action/doc-worker` |
| 项目小助理·任务看板（TaskLoopBoardPage） | **真**：Gitea 工单三列看板（待派发/执行中/已完成）+ 仓库筛选 + 运行徽标 | `GET /api/aigility/task-loop/board` → git.aigility.cloud v1 API（DNS 绕行 + token，仓库池 TASK_REPOS ∪ TASK_CHAT_REPO_MAP） |
| 项目小助理·配置与运维（TaskLoopConfigPage） | **真**：机器人启停/重启（spawn + 锁探活 + 僵锁自愈）、配置落盘、日志 tail、飞书群枚举、导航显示开关 | task-loop-manager 子进程管理（`pnpm --filter feishu-task-loop start`）+ `data/task-loop.json` |
| 应用中心·项目小助理卡 | **真**：卡片开关 = 机器人进程启停（实时查状态），打开/配置直达看板与运维页 | 同上（与配置页双向同步） |
| 团队记忆总结（TeamMemoryPage） | **真**：日报/晨报调度开关与时刻配置、TiMEM/飞书/LLM 凭证页面配置（Secret 只回掩码）、推送群可视化选取、一键立即生成（同步等待 ≤5min）、运行历史与日志 tail | team-memory-manager 进程内调度（spawn `pnpm --filter team-memory-console cli report|morning --send`，页面配置翻译为子进程 env 且优先于仓库 .env）+ `data/team-memory.json` / `team-memory-runs.json` |
| 任务板（TaskBoardPage） | **真**：任务全生命周期（建/派发/流转/产出下载），running 时 15s 条件轮询 | PG `task` 表 CAS 流转 + 执行器路由 YAML 派发 |
| 角色能力（已并入智能体工厂「角色能力 · IM」视图） | **真**：角色路由/技能货架/MCP 货架读写热生效 + missingSkills 体检；rolecaps 旧路由重定向至工厂 | `examples/feishu-dsh/roles.json`（role-registry） |
| 改进专员（FloatingImprover 悬浮） | **真**：对话式改站（sitefix 围栏 → DOM 即改 + 持久化重放） | site-improver persona + `data/site-tweaks.json` |
| 工作台 任务板/待办审批/消息 | **半真**：任务板 + 待办审批真（task 表派发与产出审）；消息卡演示 | PG `task` 表 + 执行器派发；引擎无通知服务 |
| 应用中心 其余 7 个场景应用 | 演示 · **暂不对接**（开关为货架演示态，不持久化） | 引擎无对应场景服务（会议转写需 TTS/STT 模型资产） |
| 数据接入 / 知识图谱 / 流程与组织 | 演示 · **暂不对接**（页面已标注） | 引擎无字段理解/本体映射/图谱存储服务（TiMEM 知识库服务待接入） |
| 通道与角色（已退役 2026-09-30） | 每角色通道/能力/编排配置并入智能体工厂编辑界面；路由映射与系统角色 API 保留（roles.json 热生效不变），`/channels` 重定向工厂 | — |
| 编排管理（OrchestrationPage） | **真**：数据面工作流 YAML 图形化（gyzy_platform 画布机制收编：三栏布局/节点拖拽/SVG 条件连线/循环回边/属性面板/缩放）——llm_node 的 system_prompt 与节点描述可编辑保存，服务端结构校验前置 + `flow.save` 审计；节点/连线的增删随引擎节点注册机制开放（v2） | `workflows/executor-dispatch.yaml` + `data/workflows/*.yaml`（YamlWorkflow 校验） |
| 模块装配（ModulePage） | **真**（装配底座 Phase 0, manifest 迁入 `app/src/modules/registry.ts`）：装配状态入 `app_modules` 表（登录后全端一致, localStorage 仅离线缓存）、开关写审计、工作台预设保存/套用/删除（`app_module_presets`）、core/available 服务端拒写；订阅类目仍为演示 | `docs/platform-module-plugin-design.md`；权限矩阵/租户授权仍演示（引擎无 RBAC/License 服务） |

## 插件与应用安装（装配台）

「装什么插件就变成什么工作台」——三类可安装单元：

- **工具插件**：工具插件中心「已安装插件」区块，填一条 MCP server 启动命令（或选「DSH 插件包」填 npm 包名）即完成安装（`dsh_plugins` 注册表 + dsh-host 热装载，免重启），变更入审计；「社区插件发现」区块实时检索 npm dsh-plugin 生态（GitHub topic 自动收录），点「填入安装」预填表单，装前看 repo、锁版本；
- **应用（模块/预设）**：模块装配页开关 PG 持久化（全端一致、入审计），「保存为预设 → 套用」= 给一类客户一键切换整台工作台；
- **智能体（技能）**：工厂发布即注册、立即可对话（早已闭环）。

体系设计与开源工具映射见 `docs/插件与应用安装体系设计.md`；报警分析工作台（baojing-qa）= 首个完整安装清单实例（`docs/baojing-qa-拼装设计.md`）。

## 目录结构

```
aigility-platform/
├── app/               # 前端源码（React 19 + Vite 7 + Tailwind 3 + shadcn/ui, Kimi Agent 生成收编）
│   └── src/
│       ├── lib/harness.ts       # 网关客户端：SSE 泵 + registry/发布 API + 对话调用
│       ├── pages/AgentPage.tsx  # 对话工作台（真网关对话 + 演示脚本双轨）
│       ├── pages/MarketPage.tsx # 市场（真角色区 / 工厂发布区 / 模板库）
│       ├── pages/StudioPage.tsx # 智能体工厂（发布 → 真注册）
│       └── mock/data.ts         # 产品壳演示数据（Branding.englishName = Aigility）
├── src/               # 服务端装配：AppBase 底座 + 内存内核 + 五域插件 + aigility-agent + 网关 + 静态托管
│   ├── index.ts           # 主装配（:1236 Web + :1237 网关 + 封装 API 会话保护）
│   ├── platform.ts        # AppBase 平台底座（账号/应用/网关 key 幂等种子 + /app/* 路由）
│   ├── aigility-agent.ts  # @persona/aigility-agent：工厂技能的对话入口（skill_id → system prompt）
│   ├── dsh-tool.ts        # @action/dsh-tool：DSH ctx.tools → Seam 桥（MCP 工具的 list/call）
│   ├── skill-registry.ts  # 已发布技能持久化 + 对话用量计数
│   ├── task-loop-manager.ts # 项目小助理子进程管理（启停/锁/配置/日志）+ Gitea 看板数据聚合
│   └── defaults.ts        # LLM 上游按环境自动选择（先于 layer-* 求值）
└── data/              # 运行时数据（gitignore, 除 .gitkeep）
```

## 配置（环境变量）

| 变量 | 缺省 | 说明 |
|---|---|---|
| `BIGMODEL_API_KEY` | — | 智谱开放平台 Key（配置即真实推理） |
| `BIGMODEL_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | bigmodel 兼容上游地址 |
| `LITELLM_URL` / `LITELLM_KEY` | `http://127.0.0.1:48724` / `sk-1234`（框架默认即本地代理） | LiteLLM 网关（未配 bigmodel 时生效）；本机已在用，模型池含 deepseek-v4-flash / glm-5.x / qwen 等约 38 个 |
| `LLM_PROVIDER` | 按上述自动 | 显式覆盖：`bigmodel` / `litellm` / `stub` |
| `LLM_MODEL` | `glm-4.6` | workflow-engine 默认模型（本机用 `deepseek-v4-flash`） |
| `AIGILITY_WEB_PORT` | `1236` | 平台前端端口 |
| `AIGILITY_GATEWAY_PORT` | `1237` | AI 网关端口 |
| `AIGILITY_PUBLIC_HOST` | `127.0.0.1` | （已废弃，不再使用；网关密钥不再下发前端） |
| `TIMEM_API_KEY` / `TIMEM_BASE_URL` | — | TiMEM 记忆（未配置时记忆节点静默跳过；配置不可达时 TiMEM 空间如实上报） |
| `APPBASE_PG_HOST/PORT/DATABASE/USER/PASSWORD` | `127.0.0.1:5433/appbase` | AppBase 平台 PG（登录账号 + 网关 key 持久化 + 用量计量 + dsh_plugins 注册表） |

## 执行器路由（数据面编排 · YAML）

任务板非人工任务的派发路由声明在 `workflows/executor-dispatch.yaml`（节点 + 条件边，契约与 aigility `WorkflowConfig` 对齐）——路由表可版本化、可人审：改路由 / 改执行器提示词动 YAML，不动代码。服务启动时经 `@aigility-harness/layer-orchestration` 的 `YamlWorkflow` 驱动器加载并校验（校验失败时任务派发显式 failed，服务不崩、日志指路），按任务 `executor` 字段沿条件边分流到 content / docx / workflow（PDCA 拆解）/ code（编码代理）/ human 五个执行器节点。扩展新执行器（如 mcp）：YAML 加节点与分支 + `src/index.ts` 注册对应闭包即可，路由零改动。

边界（对应 AI 治理路线图的编排分类）：YAML 只声明「节点 + 条件边」的数据面；Seam 调用、PG `task` 表状态流转等执行面逻辑留在节点函数体内，通过注册注入——与 timem-project-task 三段式「不该改编」同理。

## 工作流执行通道（workflow 执行器 · 已接通）

任务板执行器 `workflow`（复杂任务自动拆解）：Plan 阶段 LLM 拆解为子任务 DAG → 生成 aigility workflow YAML（`data/workflows/<taskId>.yaml`，复用 layer-orchestration consolidation 纯函数）→ 人审 YAML → 批准后经 py-bridge 执行（Do 段）。

Do 段执行能力（2026-09-29 接通）：SDK 侧 `aigility.workflow.runtime.run_yaml_workflow(config_path, **state)` 已随 aigility 2.1.0 落地；平台装配 `@aigility-harness/py-bridge` 并装载**平台专用声明** `config/py-plugins-aigility-platform.json`（capability `@orchestration/workflow-runtime` → `run_yaml_workflow`，无 init/method 纯函数式）。已验证：llm_node 链 LLM 降级回退 + litellm 真实推理 + worker JSON-RPC 协议三层全通。

为什么不用共享 `config/py-plugins.json`：共享文件里的 Python 版 `@orchestration/workflow-engine`（wecom 系工作流）与本平台对话链路的 TS workflow-engine 同 id——Seam resolve 取先注册者，且 autoHotSwap 健康切换可能改绑，装载共享文件会劫持对话编排。平台专用文件只含 `workflow-runtime`，零 id 冲突。

注意：py-bridge 任一 capability 初始化失败会拖垮插件 onLoad（服务无法启动）——更换 `pythonExecutable`/`workDir` 指向的 venv 前，先 CLI 验证 `run_yaml_workflow` 可跑。

## LLM 上游说明

- 优先级：`app_llm_config` 表 `platform:*` 且 `is_active=true` 的行会在启动时热应用（覆盖 env）；该行失效时对话自动降级 stub 并带【服务降级】标记。
- 本机当前走 LiteLLM 本地代理（`LLM_PROVIDER=litellm`, .env 已配），失效的 `platform:智谱` 行已停用（key 留存，修好后在 AppBase 管理端 `PUT /app/hall/llm-global` 更新即可热切回）。

## 命名说明

- **Aigility** = 「智悦」的英文名（与引擎仓 aigility-harness 同一品牌族）；平台展示层 `Branding.englishName` 随白标体系走，租户未定义英文名时不显示、切换租户不继承（防串牌）。
- 目录/包名/根脚本（`pnpm example:aigility`）/API 路径/环境变量/persona id 已统一为 `aigility` 命名。

## 与 fde-workbench 的关系

同为「Kimi Agent 生成前端 → 收编 examples → 五域 Seam 整合」，分工不同：

- **fde-workbench**：FDE 的生意台账（线索→方案→合同→交付→续费），垂直场景已接真（平台账号 + PG 持久化）；
- **aigility-platform**：FDE 的封装产线（登录 → 配数字员工 → 发布 → 贴牌交付客户），水平平台壳，三条真链路 + MCP/四个真数据区块 + AppBase 鉴权先行。

FDE 在工作台签下客户，切到 Aigility 完成配置与交付；市场页的「FDE 交付助手」即 fde-workbench 的 `@persona/fde-assistant`，两条产品线在引擎层互通。长期看 fde-workbench 可作为 Aigility「应用中心」里的一个上架应用。

<!-- 对话式改站链路已打通（平台改进专员端到端验证） -->
