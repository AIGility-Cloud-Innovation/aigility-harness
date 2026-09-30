# baojing-qa 拼装 · 关键决策资料（供拍板）

> 日期：2026-09-30 ｜ 关联：[baojing-qa-拼装设计](baojing-qa-拼装设计.md) §六
> 每个决策点：背景 → 选项与证据 → 推荐。标 ⭐ 的是待拍板项；未标的两项（前端形态、实施顺序）按设计文档推荐执行，有异议随时推翻。

---

## D1 ⭐ 报警数据存哪：AppBase PG 真表 vs 保留 MySQL

**背景**：baojing-qa 的 NL2SQL 资产是 36 个查询模板（MySQL 方言：`TIMESTAMPDIFF`/`DATE_FORMAT`/`GROUP_CONCAT`/`HOUR`），加 19 字段表结构。

| | 方案 A：AppBase PG 真表（推荐） | 方案 B：应用包自带 MySQL |
|---|---|---|
| 架构 | 单库多职，复用 AppBase 连接池/审计/权限 | 多一套数据库运维（docker 服务 + 卷 + 备份） |
| 模板移植 | 36 个模板逐个改方言：`TIMESTAMPDIFF`→`EXTRACT(EPOCH…)`、`DATE_FORMAT`→`to_char`、`GROUP_CONCAT`→`string_agg`、`HOUR(x)`→`EXTRACT(HOUR FROM x)`——机械替换，1:1 对应 | 零改动 |
| 数据导入 | Excel 列头映射逻辑照搬（方言无关） | 照搬 |
| 数据归属 | 与平台 task/audit 同域，权限/计量天然一致 | 独立库，平台治理半径外 |
| 风险 | 个别模板改写后要回归测试（模板有明确预期输出） | MySQL 8 容器在客户内网的部署负担 |

**推荐 A**。理由：36 个模板是一次性移植成本，换来的是永久的单库治理；B 的「零改动」省的是一次性成本，付的是长期运维。且 baojing 的 MySQL compose 片段保留在仓库里，客户强要求 MySQL 时随时可切 B。

---

## D2 ⭐ Neo4j 图谱接入：官方 MCP server vs 自写 @action 插件

**调研结论（2026-09-30 查证）**：Neo4j 官方维护 MCP server 套件（[neo4j-contrib/mcp-neo4j](https://github.com/neo4j-contrib/mcp-neo4j)）：

| 工具 | 能力 | 备注 |
|---|---|---|
| `get_neo4j_schema` | 节点标签/属性/关系全景（走 APOC） | **依赖 Neo4j 装并启用 APOC 插件**（社区常见踩坑点） |
| `read_neo4j_cypher` | 只读 Cypher | baojing 的查询/溯源全够用 |
| `write_neo4j_cypher` | 写 Cypher | 可关成只读模式；baojing 的图谱写入走 Cypher 导入文件，用它即可 |
| 部署 | 官方 Docker 镜像 `mcp/neo4j-cypher`，env 配 `NEO4J_URI/USERNAME/PASSWORD` | 可 `npx`/Docker 双形态，插件中心一条命令装 |

另有姊妹 server：`mcp-neo4j-memory`（知识图谱记忆）、`mcp-neo4j-data-modeling`。

| | 方案 A：官方 MCP server（推荐） | 方案 B：自写 @action/baojing-graph |
|---|---|---|
| 工程量 | **零代码**：插件中心装一行 + Neo4j 加 APOC | TS neo4j driver + schema 解析 + 子图序列化（2-3 天） |
| 能力覆盖 | schema/读写 Cypher 全有；最短路径就是一条 Cypher（`shortestPath`），读工具即可执行 | 可定制子图协议（直接产出前端 `{nodes,edges}`） |
| 与前端契约 | 需要把 MCP 工具结果转成 ForceGraph 结构（意图路由节点里做一次适配，薄） | 原生适配 |
| 维护 | 官方维护、随 Neo4j 演进 | 自担 |

**推荐 A（MCP-first）**：装官方 server， Cypher→前端子图的适配放在意图路由的 graph 节点里做一次（反正要做 sources 协议适配）。若后期发现子图适配层越写越重，再升级 B，MCP 路径沉淀为准入清单里的保底。**前置动作**：Neo4j 容器启用 APOC（官方镜像加 `NEO4J_PLUGINS=["apoc"]` 即可）。

---

## D3 前端形态（按推荐执行）：跳过 iframe 直接收编智悦 SPA 子树

同栈（React+Vite+Tailwind+ECharts）、仅 4 个子页，收编成本低；ForceGraph 与 TwinGraph3D 以目录命名空间隔离。按拼装设计 §六 S3 执行。

## D5 实施顺序（按推荐执行）：装配底座已落地 → Phase 1 引擎能力先行

---

## D4 ⭐ 问答来源审计（sources/子图）怎么传给前端

**调研结论**：业界惯例（Perplexity 流式引用、Azure OpenAI RAG 元数据）是——**正文走标准 chat.completions 增量帧保证兼容性，引用/来源放在流末尾的附加帧**（自定义 `event:` 或最后一个 data 帧），而非自造独立查询端点多一次往返。

| | 方案 A：SSE 尾帧（推荐） | 方案 B：独立回查端点 |
|---|---|---|
| 协议 | 标准帧流完 → 追加一帧自定义事件（sources + 子图 + 阶段耗时） | 标准 SSE 不动；前端拿 message id 另查 `GET /api/aigility/chat/:id/sources` |
| 兼容性 | 标准 OpenAI 客户端忽略未知帧即可（需验证我们自己的 pumpOpenAiSse） | 完全零侵入 |
| 复杂度 | 网关编码 + 前端解析各改一处 | 服务端要暂存 sources（内存/TTL），多一次往返 |
| 时序 | 天然同请求送达 | 有「正文完了 sources 还没落库」的竞态要处理 |

**推荐 A**。附加帧设计：`data: {"aigility_sources": {"sources": [{type:"sql"|"cypher", query, rows, status}], "graph": {nodes, edges}, "stages": {...}}}`，紧跟现有 `[DONE]` 帧之前。

---

## D6 ⭐ dsh 套件升级时机：rc.2 → 0.2.0-rc.2

**调研结论（npm registry 查证）**：

- 官方 `@deepseek-ai/dsh` 当前 **`latest` = `next` = `0.2.0-rc.2`**；本仓精确锁 `0.1.5-rc.2`
- 0.2.0 的 CLI 描述已变为「profile boot, **plugin management**, browser UI alias」——社区插件市场用的 `dsh plugin add` 命令就是 0.2.0 的产物；**不升级就无法用官方插件管理链路**
- 社区插件普遍按新版套件开发（hub 标注 dshTarget），锁 rc.2 时第三方插件兼容性没有保证
- 升级风险：pre-1.0 官方明示破坏性变更；本仓的对冲机制齐备——`cordisAligned` 实例对齐校验（测试固化，false 即拒绝装载）+ 升级演练流程（沙箱分支 bump → kernel-dsh 冒烟 → 全量测试 → 记录 breaking）+ 遥测默认硬关闭

| | 方案 A：先升级演练再拼装（推荐） | 方案 B：锁 rc.2 直接拼装 |
|---|---|---|
| 顺序 | 沙箱分支 bump 0.2.0-rc.2 → 冒烟 → 合入 → 再装 Neo4j MCP/社区插件 | rc.2 直接装官方 MCP server（MCP 走 stdio/HTTP，不依赖套件版本）|
| 风险 | 0.1.5→0.2.0 可能 breaking，需过一遍五域冒烟 | 官方 MCP 类插件不受影响；**第三方 DSH 插件基本装不了** |
| 收益 | 第三方生态全开 + 官方 `dsh plugin` 链路可用 | 拼装不被升级阻塞 |

**推荐**：**baojing 拼装不被升级阻塞**——它依赖的 Neo4j MCP 是独立进程，rc.2 就能装。升级演练作为独立事项排在拼装期间并行做（沙箱分支先试），合入后再放开第三方 DSH 插件准入。

---

## 决策汇总（2026-09-30 已拍板）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 报警数据存储 | ✅ **AppBase PG 真表**（移植 36 模板） |
| D2 | Neo4j 接入 | ✅ **官方 mcp-neo4j-cypher**（插件中心装，APOC 前置） |
| D4 | sources 协议 | ✅ **SSE 尾帧**（Perplexity 同款模式） |
| D6 | dsh 升级 | ✅ **先探明再定** → 探明结论见 [dsh-升级影响评估-0.2.0](dsh-升级影响评估-0.2.0.md)：低风险增量（cordis 同 4.x、行清单零删除、`!!js` 无新形态），建议沙箱演练半天后合入，**与拼装并行不互阻**；执行方案待用户确认 |
| D3/D5 | 前端收编 / 顺序 | 按拼装设计推荐执行 |

来源：[neo4j-contrib/mcp-neo4j](https://github.com/neo4j-contrib/mcp-neo4j) · [Neo4j MCP 集成页](https://neo4j.com/developer/genai-ecosystem/model-context-protocol-mcp/) · [mcp/neo4j-cypher Docker 镜像](https://hub.docker.com/r/mcp/neo4j-cypher) · [Perplexity 流式引用](https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README) · [Azure OpenAI 引用元数据讨论](https://learn.microsoft.com/en-sg/answers/questions/2246687/how-can-i-get-citation-metadata-like-source-links) · [OpenAI 流式文档](https://developers.openai.com/api/docs/guides/streaming-responses) · npm registry `@deepseek-ai/dsh`（dist-tags 查证）
