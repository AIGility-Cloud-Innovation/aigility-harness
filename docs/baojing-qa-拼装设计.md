# 智悦拼装 baojing-qa（工业智能报警分析）设计

> 版本：v0.1 ｜ 日期：2026-09-29 ｜ 状态：草案待审
>
> 定位：回答「智悦智能平台（aigility-platform）如何拼装出 baojing-qa（工业智能报警分析平台）的能力」——**模块尽量复用，前端可展示的模块尽量在用户可操作范围内可配置**。
> 素材：`.tmp-baojing`（git.aigility.cloud/yuanrong/baojing-qa 工作副本）能力盘点 ｜ [platform-module-plugin-design](platform-module-plugin-design.md)（装配底座）｜ [真实数据接入盘点](真实数据接入盘点.md)（平台现状基线）

---

## 一、结论

1. **baojing-qa 的业务逻辑平台无关度很高**：真正值钱的是 prompt/模板库（36 个 NL2SQL 模板、Cypher 生成模板、意图路由规则）、三级降级的意图编排模式（LLM → 规则模板 → 模糊提示）、图谱本体（8 节点/10 关系）、流式事件 + 来源审计协议、ECharts 可视化组件。FastAPI 路由壳（约 1000 行）、Redis、约 2500 行遗留 LangGraph 代码、无鉴权状态**全部可弃**——鉴权/审计/计量由智悦 AppBase 底座无偿补齐。
2. **智悦侧新增量集中且薄**：1 个本地 persona 插件（报警 QA 助手）+ 2~3 个 @action 数据访问能力（报警 SQL / 图谱查询 / 数据导入）+ 1 份意图路由 YAML + 1 个应用包预设。其余全部复用现有模块。
3. **可配置性的底座已有现成设计**：`platform-module-plugin-design.md` 的装配层（ModuleManifest 注册表 + `app_modules`/`app_module_presets` PG 表 + ModulePage 真化）正是「所有前端可展示模块可配置」的机制，baojing-qa 是它的第二个真实消费者（第一个是 fde-workbench）。**Phase 0 装配底座应先于本方案实施。**

---

## 二、baojing-qa 资产盘点（拆解视角）

| 类别 | 内容 | 处置 |
|---|---|---|
| **可搬资产** | 36 个 NL2SQL 查询模板 + 19 字段表结构说明（`sql_agent.py`）；Cypher 生成 prompt（Schema+同义词+8 示例，`config.yaml` cypher_prompt）+ 10 类规则 Cypher 模板 + 三层实体匹配（`graph_agent.py`）；意图两级路由（关键词优先 + LLM 兜底四分类 sql/graph/mixed/general，`orchestrator.py`）；图谱本体 8 节点 10 关系 + 配色规范；流式阶段事件 + sources 审计协议（`{type:sql\|cypher, query, rows, status}`）；ForceGraph 组件（React+ECharts，吃标准 `{nodes,edges}` 结构）；19 字段 Excel 中文列头映射 + 2.5MB 测试数据 + Cypher 导入文件 | 直接移植 |
| **需适配** | MySQL 方言 SQL（TIMESTAMPDIFF/DATE_FORMAT/GROUP_CONCAT）→ 换库则改写；`SQLChatMessageHistory` MySQL 会话存储 → 平台会话链路；neo4j driver 原生类型解析 → 平台侧序列化；Excel 导入链路 → 平台数据源管理 | 重写适配层 |
| **直接丢弃** | Redis 全部（现行链路闲置）；`llm_service.py` 等遗留 LangGraph 层；MemoryEngine mock 页（后端无实现，智悦 TiMEM 空间已覆盖）；G6 空依赖；静态 API-Key「鉴权」 | — |

---

## 三、五域拼装映射

| 五域 | baojing-qa 对应物 | 智悦落点 | 复用/新增 |
|---|---|---|---|
| D5 人格 | GeneralAgent 人设 + 统一问答入口 | `@persona/baojing-qa-agent`（示例本地插件，复用 aigility-agent 的 skill_id → system prompt 装配模式），在智能体工厂可发布可改 | **新增插件**，模式复用 |
| D4 编排 | Orchestrator 意图路由（sql/graph/mixed/general 四分支） | **意图路由 YAML**（classify 节点 + 条件边），与 `workflows/executor-dispatch.yaml` 同款数据面模式，TS `YamlWorkflow` 驱动、节点闭包调 Seam；关键词表/LLM 兜底 prompt 外置 YAML 可版本化 | **新增 YAML**，驱动器复用 |
| D3 行动 | SqlAgent 查询执行 + GraphAgent Cypher 执行 + Excel/Cypher 导入 | `@action/alarm-query`（PG `alarm_log` 查询执行）、`@action/baojing-graph`（Neo4j：Cypher/最短路径/schema/子图序列化）、`@action/baojing-import`（Excel 列头映射导入 + Cypher 文件导入） | **新增 3 个能力**，Provider 模式复用（对齐 doc-worker/dsh-tool） |
| D2 认知 | chat 模型 + cypher 模型双模型分工 | 复用 `@cognitive/llm-inference`；双模型 = `LLM_MODEL` + `CYPHER_MODEL` env（bigmodel/litellm 已接入） | **纯复用** |
| D1 底座 | 无鉴权 + 静态 API Key | 复用 AppBase 登录鉴权/审计/Token 计量/积分预扣（能力**升级**：baojing 原系统无用户体系） | **纯复用** |

> 通道分工：**意图路由走 TS `YamlWorkflow`**（节点需调 Seam 数据能力，同 executor-dispatch）；py-bridge `run_yaml_workflow` 通道（P0 正在接通）服务于「复杂分析任务 Plan 拆解 → 人审 → 执行」，如「时段关联根因分析」类长任务。两者不混用。

---

## 四、页面级模块复用映射（7 页 → 智悦）

| baojing-qa 页面 | 智悦落点 | 形态 |
|---|---|---|
| AIAssistant 统一问答 | **AgentPage 对话工作台** + 报警 QA 技能（对话身份切换即得） | 复用对话链路（SSE 流式/会话/网关）；扩展：SSE 尾帧携带 sources 审计 + 子图事件，AgentPage 增加审计面板分区 |
| GraphVisualization 图谱全量可视化 | **GraphPage 真化**（现有 TwinGraph3D/EChart 组件 + mock `graphNodes` 换 Neo4j 真数据） | **模块整体复用**——智悦知识图谱页从 Mock 转真的第一个真实场景（盘点文档 P3 项由此解锁） |
| Dashboard 统计看板 | 报警 KPI 卡 + 趋势/占比/Top 测点 → 应用包「报警看板」子页；平台 Dashboard 真化（P1-3）另计 | ECharts 配置直接搬运（智悦已有 EChart 封装 + OpsPage 真指标模式） |
| AlarmList 报警数据 | 应用包「报警数据」子页：分页表格 + 多维筛选 + 筛选选项接口 | UI 模式复用（AuthPage 成员表/任务板表格）；数据进平台 PG |
| DataUpload 数据导入 | 应用包「数据导入」子页：Excel→报警表、Cypher→图谱；进度反馈 | 上传模式复用（报告中心）；导入逻辑进 @action/baojing-import；**智悦 DataIngest（字段理解/本体映射 mock 页）的真化由本场景驱动**——中文列头映射即字段理解 v1 |
| MemoryEngine 记忆引擎 | 丢弃（TiMEM 空间已覆盖记忆/知识） | — |
| Help | 丢弃或并入平台帮助 | — |

**数据落位**：报警日志 19 字段在平台 PG 建 `alarm_log` 真表（platform.ts 建表惯例，NL2SQL 需要真实关系表而非 app_rows JSONB）；会话历史复用平台对话链路，不再建 session/dialog 两表。

---

## 五、可配置性设计（四个层次，按用户可操作范围）

| 层 | 操作者 | 可配置内容 | 机制 |
|---|---|---|---|
| **板块装配层** | 集成商/平台管理员 | 报警分析应用包的 5 个模块（报警看板/报警数据/知识图谱/问答中心/数据导入）独立开关；预设一键装配/卸下；导航显隐 + 路由守卫 | platform-module-plugin-design Phase 0：`app/src/modules/registry.ts` + `app_modules`/`app_module_presets` 表 + ModulePage 真化 + `module.toggle` 审计。**预设 `baojing-qa` = 应用包模块开 + 无关演示壳模块按需关** |
| **数据源层** | 平台管理员 | Neo4j 连接（URI/账号/密码）、报警库参数；连接测试按钮 | 对齐 `app_llm_config` 热应用先例：配置表 + SettingsPage（现状 Mock）真化的数据源分区；`@action/baojing-graph` 启动时读配置 |
| **技能层** | FDE（智能体工厂） | 报警 QA 助手的 system prompt、意图关键词表、双模型选择（chat/cypher 模型）；36 SQL 模板与 10 类 Cypher 模板作为版本化资产随 YAML 管理 | 工厂发布 = skill-registry 真注册；模板/关键词外置 YAML（对齐 executor-dispatch「改路由不动代码」理念） |
| **展示层** | 终端用户 | 看板卡片显隐、图谱节点类型/关系过滤与配色、列表筛选器默认值、问答面板布局 | 用户级配置存 AppBase `/app/data` JSONB（对齐 report_templates 先例），页面内即改即存 |

治理边界：`core` 模块不可关（服务端拒写）；装配与数据源变更入 `audit_log`；导入/删除报警数据等敏感操作的权限对齐 app-permission-design 的 r-admin 语义。

---

## 六、关键决策点（待拍板）

| # | 决策 | 选项与建议 |
|---|---|---|
| 1 | 报警数据存储 | **建议 AppBase PG 真表**（单库多职原则；36 模板移植 PG 方言：`TIMESTAMPDIFF`→`EXTRACT(EPOCH …)`、`DATE_FORMAT`→`to_char`、`GROUP_CONCAT`→`string_agg`，移植量可控）。备选：应用包自带 MySQL docker（模板零改动，但破坏单库架构、多一套运维） |
| 2 | Neo4j 引入方式 | **建议示例本地 `@action/baojing-graph` 插件直连**（不改框架包，对齐 dsh-tool/aigility-agent 先例）；GraphStore 契约化（D1「单库多职第四契约」）待第二个图场景出现再做。部署拓扑新增 neo4j 容器（照抄 baojing compose 片段） |
| 3 | 前端形态 | **建议跳过 S1/S2 直接收编智悦 SPA 子树**（platform-module-plugin-design 的 S3 inline 模式）：baojing 前端与智悦同栈（React+Vite+Tailwind+ECharts），仅 4 个子页，收编成本低；ForceGraph/TwinGraph3D 以目录命名空间隔离 |
| 4 | sources 审计协议 | **建议 SSE 尾帧扩展**：OpenAI 兼容流结束后追加一帧自定义事件（sources + 子图 + 阶段耗时），前端 `pumpOpenAiSse` 旁路解析；备选独立查询端点（按 message id 回查，多一次往返） |
| 5 | 实施顺序 | **Phase 0 装配底座先行**（它同时服务 fde-workbench 接入与本项目，约 1 天）；引擎能力 → 前端模块 → 预设收尾 |

---

## 七、实施阶段

| 阶段 | 内容 | 估量 | 前置 |
|---|---|---|---|
| **Phase 0 装配底座** | = platform-module-plugin-design Phase 0：registry.ts 迁入 + `app_modules`/`app_module_presets` 建表 + modules 封装 API + ModulePage 真化 | ~1 天 | 无（可立即做） |
| **Phase 1 引擎能力** | `alarm_log` 建表 + 种子导入测试数据；`@action/alarm-query`（36 模板 PG 方言移植 + NL2SQL 双通道）；`@action/baojing-graph`（Neo4j client + schema/子图序列化）；`@action/baojing-import`；意图路由 YAML + `@persona/baojing-qa-agent`；SSE 尾帧协议 | ~2-3 天 | Neo4j 容器就绪 |
| **Phase 2 前端模块** | GraphPage 真化（接 @action/baojing-graph）；应用包 4 子页收编（ForceGraph/ECharts 搬运 + 改造）；AgentPage 审计面板 | ~2-3 天 | Phase 1 |
| **Phase 3 预设与配置化收尾** | `baojing-qa` 预设种子；数据源管理分区（SettingsPage 真化第一步）；工厂技能模板；展示层用户配置 | ~1 天 | Phase 0-2 |

---

## 八、与在途工作的关系

- **P0（workflow Do 段 py-bridge 接通）**：非本方案强前置（意图路由走 TS YamlWorkflow），但「时段关联分析」类长任务的自动拆解执行依赖它；
- **P1-3 Dashboard 真化**：报警看板与平台 Dashboard 共用真数据模式，可协同实施；
- **GraphPage 真化**：盘点文档中「知识图谱 · 引擎能力缺口 P3」由本方案解锁第一个真实场景；
- **DataIngest 真化**：中文列头映射导入即「字段理解 v1」，本方案的导入链路是其第一个落地实例。
