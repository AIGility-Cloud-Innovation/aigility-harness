# Persona 三级生命周期设计（模板级 / 引擎级 / 应用级）

> 2026-10-08 定稿 v1。输入材料：DSH 实测情报（patch 覆盖 agent-instructions 已验证）、
> 本仓代码核验（role-kit ElizaOS 转换器 / session-relay buildRolePatchFile / 站点存根现状）、
> 负责人三项拍板（见 §5 决策记录）。
> 结论先行：**不引入外部包**（Langfuse/Dify/Coze 均不匹配，见 §7），复用既有 role-kit 双层 +
> ElizaOS 交换格式，只补三段小改动 + 一个生效验证面板。
>
> **实施进度（2026-10-08）**：分支 `feat/persona-three-tier`；**M-A ✅ / M-B ✅ / M-C ✅ 已实现**，
> M-D 未开始（生效验证面板，一期/二期均未闭合项）。落地口径与初稿偏差见 §3 各节「实施记录」，
> 交付清单见 §7。

---

## 1. 三层定义与文件映射

```
模板级（出厂，layer-persona + role-kit 角色包，git 版本化）——只做实现，不带调试
      │ ① 引擎级投递（渲染/patch）
      ▼
引擎级（各引擎运行时实际加载的原生配置）★ 本期范围：dsh
      │ ② 应用改写（copy-on-override + 非退化校验）
      ▼
应用级（站点副本 data/roles/<id>/SKILL.md）
      │ ③ 提升回流（管理员 + 校验，另存为新出厂模板）
      ⇄ 回到模板级
```

| 引擎 | 原生人格载体 | 本期 |
|---|---|---|
| dsh | `agent-instructions`（instructionFileCandidates）+ roles.json/skill/patch | ✅ 本期 |
| pi | `<agent-dir>/AGENTS.md` + APPEND_SYSTEM.md + models.json + extensions | 下一批（文件复制，无技术难点） |
| codex | AGENTS.md + ~/.codex/config.toml | 下一批 |

**模板正文单文本投递**（2026-10-08 二次拍板，取代分段方案）：

人格是同一身份——既对用户说话、也按纪律干活，**不把"客服"与"工人"拆成两套文本**。
SKILL.md 人设全文即引擎级 AGENTS.md 的正文来源；某应用需要差异化口吻时，
走应用级 override 微调（M-B 机制），不靠模板分段。

### 模板格式：兼容优先（2026-10-08 定稿原则）

> 原则：**优先用兼容的形式，迫不得已再原创**。参考系：Anthropic Agent Skills、
> ElizaOS character.json、pi 原生约定、dsh skill 约定。

角色包定稿形态：

```
roles/<role-id>/
  SKILL.md       ← 人设唯一事实源（Anthropic Agent Skills 规范：
                    frontmatter name=小写连字符≤64（即 role-id）、description=一句话；
                    正文 = 人设全文，不分段）
  role.json      ← 仅存"业界无格式可覆盖"的编排语义（原创保留区）：
                    { schema_version: 1, role_id, identity.capability_ref,
                      sources{channels,data},
                      actions{tools,workflows,commands,schedules,engine},
                      outbound{reply,push}, memory }
  character.json ← （导出物，不入库）ElizaOS 交换格式，由前两者生成
```

| 内容 | 归宿 | 参考系 |
|---|---|---|
| 人设正文 + 名称/描述 | **SKILL.md**（Anthropic 规范 = pi skills = dsh skill 三家公共分母） | Agent Skills / pi skills.md / dsh skill |
| 对外交换 | **character.json**（导出物） | ElizaOS |
| 引擎指令 | **AGENTS.md**（渲染产物：pi/codex 原生读） | AGENTS.md 惯例 |
| 通道订阅 / 数据绑定 / 调度 / 引擎委托 / 记忆域 | **role.json 编排保留区** | ⚠️ 迫不得已的原创——业界无对应格式 |

迁移项（一次性）：① SKILL.md frontmatter `name` 合规化（小写连字符，中文显示名挪 description）；
② role.json **缩编**——删除 `identity.name`（人设唯一事实源=SKILL.md），其余编排字段保留。

### role.json 原创性的逐字段审计（2026-10-08）

原则「优先兼容、迫不得已原创」逐字段核验结论：**缩编后的 role.json 是当前最优解**。

| 字段 | 业界最接近标准 | 结论 |
|---|---|---|
| sources.channels（IM app/群订阅） | 各 IM 平台私有配置，无跨平台标准 | ✅ 原创 |
| sources.data（数据资产绑定） | MCP resources 语义不合（被动绑定非按需工具） | ✅ 原创 |
| actions.tools | MCP/function calling 是标准，但 harness 工具为进程内 seam 服务（MCP 化=已否决的路径二） | ⚠️ 保留，未来开放第三方时支持 `mcp://` 引用 |
| actions.workflows / commands / schedules / engine | 无对应标准（cron 丢动作语义） | ✅ 原创 |
| outbound / memory | 无 | ✅ 原创 |

定位：role.json 是**机器消费面**（session-relay 热读/task-loop/调度器），兼容性无收益；
生态兼容已由 SKILL.md（Agent Skills）+ AGENTS.md（指令惯例）+ character.json（ElizaOS 交换）
三个界面承担。纪律：role.json 增加 `schema_version` 字段，增字段前先查业界。

---

## 2. 实测与核验基础（设计依据，全部本机验证）

| # | 事实 | 验证方式 |
|---|---|---|
| 1 | `--patch` 叠加层可按 id 覆盖 `agent-instructions` 行：默认候选 `["AGENTS.md","CLAUDE.md"]` patch 后收窄为 `["AGENTS.md"]`，注入 415 字节 | DSH 实测：headless 最小会话 + 解压 session jsonl 读回注入事件 |
| 2 | role-kit 已有 ElizaOS 双向转换器 `toElizaCharacter`（:199）/`fromElizaCharacter`（:225）；平台已有 `/role-packages/:id/eliza` 导出与 `import-eliza` 导入 | 源码核验 |
| 3 | `buildRolePatchFile`（session-relay.ts:130，:430 调用）现有两分支：skill-filesystem 覆盖 + mcp-client 插入；无能力时返回 null | 源码核验 |
| 4 | 站点副本存根坑：`data/roles/sales-chat/SKILL.md` 正文为占位文案（比出厂版更差），现状"保存为站点角色"会用存根覆盖出厂文本 | 文件核验 |
| 5 | pi 原生读 `AGENTS.md/AGENTS.override.md/APPEND_SYSTEM.md/CLAUDE.md`（用户级+项目级两级） | pi 官方文档 configuration.md |

### 实施期补充核验（2026-10-08，M-A/M-B）

| # | 事实 | 验证方式 |
|---|---|---|
| 6 | `RoleRegistry` 原先**无角色包目录概念**，`instructionsFile` 需手工配置且全仓无一处配置（等于 M-A 死代码） | 源码核验 + `grep instructionsFile examples/feishu-dsh/roles.json` |
| 7 | `agent-instructions` patch 的 `maxBytes` 为 dsh-base schema **必填**（缺省 65536） | 既有实现注释 + schema 核验 |
| 8 | patch 目录在快照写入后才 `mkdirSync`：目录不存在时 `copyFileSync` ENOENT | 新增单测首次运行即复现 |
| 9 | 站点副本写入路径有**两条**（`PUT /role-packages/:id`、`POST /role-packages/import-eliza`），不止"保存为站点角色" | 源码核验 |
| 10 | `data/roles/sales-chat/SKILL.md` 已提交入库（非 gitignored），且 `name` 为中文 `销售客服`、正文含占位标记 | `git ls-files` + 文件核验 |

---

## 3. 设计：四段改动

> 实现状态（2026-10-08 实施记录，分支 `feat/persona-three-tier`）：
> **M-A ✅ 已实现 · M-B ✅ 已实现 · M-C ✅ 已实现 · M-D ⬜ 未开始**。
> 下面每节末尾的「实施记录」写明落地口径与偏差。

### M-A 引擎级投递（dsh patch 第三分支）✅

`buildRolePatchFile()`（`packages/dsh-interop/src/session-relay.ts`）第三分支：

1. 将角色包 SKILL.md 人设正文（单文本，见 §1）写为 `patchDir/AGENTS-<role.id>.md`；
2. patch 追加 `{ id: "agent-instructions", config: { instructionFileCandidates: [<该文件绝对路径>], maxBytes: 65536 } }`
   ——收窄候选表使角色专属文件成为唯一注入源（DSH 实测：覆盖后 baseline identity 的
   candidates 从 `["AGENTS.md","CLAUDE.md"]` 变为单候选，即配置生效的硬证据）。

**纪律**：patch 条目全部追加式（不删既有条目）；角色包无人设文件时不出该分支（零开销，与
现有"无能力不产出文件"约定一致）。

**实施记录（与本文档初稿的三处偏差，均为实现期澄清）**：

- **人设来源 = 角色包自动解析，非手工配置**。初稿的实现把 `SKILL.md` 全文投递依赖
  `roles.json` 里手工填的 `instructionsFile`（且当时**全仓无人配置**，等于死代码）。
  本期改为：`RoleRegistry` 新增 `rolesDirs`（角色包目录列表，相对注册表目录解析），
  `buildRolePatchFile` 按 **显式 `instructionsFile`（逃生舱）> 角色包 `<rolesDir>/<role.id>/SKILL.md`**
  的优先级解析，最终才回落官方缺省候选。这才真正兑现 §1「SKILL.md 是人设唯一事实源」。
- **快照只写正文，不复制原文件**。初稿 `copyFileSync` 会把 SKILL.md 的 YAML frontmatter
  一并注入 system prompt；本期改为剥除 frontmatter 后只写正文（`AGENTS-<id>.md`）。
- **`maxBytes: 65536` 是 schema 必填项**（初稿未提）。与官方缺省对齐，防止超长指令被静默截断。
- `default` 角色（无专属人设）不走角色包解析，避免把兜底角色的 SKILL 误当专属人格注入。
- 附带修复：patch 目录原在快照写入**之后**才 `mkdirSync`，导致 patch 目录不存在时
  `copyFileSync` ENOENT（单测暴露）；已提前创建。

单测：`packages/dsh-interop/src/session-relay.test.ts` 新增 4 例（正文剥 frontmatter /
缺失与空正文不产分支 / default 不解析 / 显式 instructionsFile 优先）。

### M-B 应用级 copy-on-override + 存根/退化校验 ✅

现状"保存为站点角色"是纯复制（且会把存根覆盖成正文——sales-chat 已是实例）。增加写入前校验
（实现于 `packages/role-kit` 的 `validateSitePersona`，供编辑器与消费站点共用）：

- **非空**：剥离 frontmatter/空行后正文 ≥ 80 字符；
- **非退化**：副本正文与出厂模板正文归一化后**不同**（禁用"存根原样复制"）；
- **非占位**：不得包含「定制副本：在此撰写完整人设」「人设待补」等占位标记。

校验失败返回 400 并附 `issues` 数组，拒绝保存。

**实施记录**：

- 接线点两处（**不止一处**）：`PUT /role-packages/:id`（工厂保存 / copy-on-override）与
  `POST /role-packages/import-eliza`（ElizaOS 导入同样写站点副本）。初稿只提到前者。
- **仅在"实际写入正文"时校验**：不传 `prompt`（只改编排字段，如通道/调度）视为保留原人设，放行
  ——否则"只改调度"这类编辑会被误拦。
- **非退化比对仅在有出厂模板时生效**：站点独有角色（如 `sales-chat`，公共层无同 id）无参照系，
  跳过该项，只做非空 + 非占位。
- 初稿末句「形象节进对话人格，纪律节按需附加」中的"节"在单文本方案（M-E 已取消）下已无定义，
  已按 §1 口径改为：**应用副本整体覆盖，不做节选择**。
- **旧账已清**：`data/roles/sales-chat/SKILL.md` 由存根重写为完整人设（285 字符），
  同时修正 `name`（`销售客服` → `sales-chat`，中文显示名挪 `description`），
  §1 迁移项 ① 对该角色已闭合。**其余站点角色（site-improver / zy-mui8eu02 / zy-mui89q94）
  的 `name` 仍是中文，属 §1 一次性迁移的未完成部分**，不影响 M-B 校验（校验只看正文）。

单测：`packages/role-kit/src/index.test.ts` 新增 6 例（三重校验各自拒绝/放行、
空白与 frontmatter 差异仍判退化、无模板跳过退化比对、归一化函数）。

### M-C 提升回流（站点 → 出厂模板）

权限（负责人拍板 §5-2）：**智悦平台 isAdmin** + 非退化校验 + 审计日志
（`writeAudit("role.promote", ...)`）。提升动作 = 把站点副本正文写回
`packages/role-kit/roles/<id>/SKILL.md`，走 **git PR 人审**后随版本分发所有站点。

> **实施记录（2026-10-08 落地）**：按上述口径实现，`role-kit 23 passed`。
>
> - `packages/role-kit/src/index.ts`：`checkPromotion` / `renderPromotedSkillMd` /
>   `buildPromotion` 纯函数（无 IO），`PROMOTION_IDENTICAL_ISSUE` 文案常量化。
> - `examples/aigility-platform/src/index.ts`：`POST /api/aigility/role-packages/:id/promote`，
>   isAdmin 门禁 + 仅 `layer === 'site'` 可提升 + 审计；写盘先写 `.promote-tmp` 再 rename（原子）。
> - 工厂页入口仅对 `origin === 'site'` 且 isAdmin 显示，confirm 写明影响面。
>
> **两处口径偏差（均为收紧，非放宽）**：
> ① 设计只写"非退化校验"，实做额外要求**出厂模板必须已存在且正文确有差异**——
> 否则一次误点就在 git 里产生一个空 PR；
> ② 提升时**复用目标模板的 frontmatter**，不用站点副本的：出厂 `name` 是英文 `role.id`，
> 站点副本可能仍是中文显示名（§1 迁移项 ① 未全量闭合），沿用站点 frontmatter 会把
> 中文显示名带进公共层，构成该迁移项的回归。

### M-D 生效验证（不可省）⬜ 未开始

解析 dsh 会话 jsonl 的 `agent-instructions` 注入事件，在工厂角色页展示：
**实际注入 N 字节 · 来源文件 · 候选表**。没有这一步，"AGENTS.md 首候选就位却常年零字节"
这类静默失效无法察觉（本轮 DSH 能拿到硬证据，正是因为做了这一步）。

> **实施记录（2026-10-08）**：**未做**。已核验当前工作区与提交中均无 `agent-instructions`
> 的 jsonl 解析代码（`grep -rn "agent-instructions" --include=*.ts` 只命中
> `packages/dsh-interop/src/session-relay.ts` 的 patch **生成**侧与对应单测，
> 即 M-A 的投递端；**解析/展示端不存在**）。M-A 的投递在 UI 上仍**不可观测**。

### ~~M-E 分节解析器~~（已取消）

2026-10-08 二次拍板：不做分段投递——人格是同一身份，差异化口吻走应用级 override 微调，
不拆模板。M-E 与配套单测取消；§4 决策记录同步修订。

---

## 4. 决策记录（负责人 2026-10-08 拍板）

| # | 决策 | 选择 | 备注 |
|---|---|---|---|
| 1 | 模板文本分段 | ~~单文件标记分节~~ → **已二次拍板取消（2026-10-08）**：单文本投递，人格同一身份；差异化走应用级 override | M-E 解析器取消；差异化需求由 M-B 承接 |
| 2 | 提升权限 | **平台管理员 + 非退化校验 + 审计** | 非框架维护者通道；git PR 审查由维护者在合入时把关 |
| 3 | 本期投递范围 | **dsh 先行**（instructionFileCandidates patch） | pi/codex 的 AGENTS.md 写入为纯文件复制，下一批 |

> 三项均标注"按推荐默认先行、可后调"：分段方案改双文件、权限改申请-审批制，均为局部替换。

---

## 5. 与既有资产的关系

- **ElizaOS 兼容层**（role-kit 转换器 + 平台导出/导入）：保留，定位为**对外交换格式**
  （别人能用 character file 导入/导出角色），与本期三级生命周期正交。
- **role-kit 双层目录**（公共 roles/ + 站点 roles/，同 id 站点优先）：保留，定位为
  **模板与站点副本的存放与解析规则**。
- **外部 prompt 管理平台**（Langfuse/Agenta/Pezzo）与 **Dify/Coze/FastGPT 类搭建平台**：
  不引入——前者只覆盖 prompt 版本化且为外部依赖（与私有化定位有张力），后者粒度不对
  （persona 是平台内配置项，不产出可版本化、可跨系统安装的模板）。来源：Agenta 对比文、
  Nearform 独立评测（2025-10）、本机三体系合订版 §7。

## 6. 风险与纪律

- **前缀缓存**：模板/站点副本一旦投递即成为引擎 system prompt 前缀——发布与改写要有节奏
  （改写=缓存重建，参见 docs/token-mechanism-plan.md 与省 Token 秘籍第 4 层）。
- **pi 无权限系统**：pi 侧投递（下一批）只放人读指令文件，不放密钥。
- **存根坑已堵（2026-10-08）**：M-B 三重校验上线，且 `sales-chat` 旧存根已重写为完整人设。
  回归点：新写站点副本若只改 `prompt` 之外字段应放行，仅改人设才走校验。

## 7. 里程碑

> **进度（2026-10-08）**：一期 ✅ 完成 · 二期 ✅ **完成（M-B + M-C 均已落地）**
> · 三期 ⬜ 未开始 · 四期 ⬜ 未开始。分支 `feat/persona-three-tier`。

| 期 | 内容 | 量级 | 状态 |
|---|---|---|---|
| 一 | M-A dsh patch 第三分支（角色包 SKILL.md 正文 → AGENTS.md）+ 单测 | ~50 行 | ✅ 完成（实做 ~75 行含注释 + 4 例单测） |
| 二 | M-B 应用副本校验 ✅ ／ M-C 管理员提升 + 审计 ✅ | ~120 行 | ✅ 完成（实做 ~160 行含注释；M-C 底座 +7 例、接线端点与 UI） |
| 三 | M-D 生效验证面板（jsonl 解析 → 工厂页展示） | ~150 行 | ⬜ 未开始 |
| 四 | pi/codex AGENTS.md 投递扩展 | ~40 行 | ⬜ 未开始 |

### 本期已交付清单（可回归）

| 项 | 落点 | 验证 |
|---|---|---|
| M-A 角色包 → patch 投递 | `packages/dsh-interop/src/session-relay.ts` | `npx vitest run packages/dsh-interop`（54 passed） |
| M-B 三重校验（共享机制） | `packages/role-kit/src/index.ts`（`validateSitePersona` / `normalizePersonaBody`） | `npx vitest run packages/role-kit`（23 passed，含 M-C +7） |
| M-B 接线（保存 + 导入两路径） | `examples/aigility-platform/src/index.ts` | `tsc --noEmit` 通过 |
| M-C 提升底座（校验 + 渲染 + 组装） | `packages/role-kit/src/index.ts`（`checkPromotion` / `renderPromotedSkillMd` / `buildPromotion`） | `npx vitest run packages/role-kit`（23 passed） |
| M-C 接线（端点 + 审计 + 工厂页入口） | `examples/aigility-platform/src/index.ts`、`app/src/pages/StudioPage.tsx` | `tsc --noEmit` 通过 |
| 环境变量泄漏假红灯修复 | `packages/layer-persona/src/feishu-task-assistant.test.ts`、`packages/layer-action/src/pi-agent.test.ts` | 全量 exit 0；敌意环境（三个 env 注入 bogus）同样全绿 |
| sales-chat 存根旧账清理 | `examples/aigility-platform/data/roles/sales-chat/SKILL.md` | `validateSitePersona` 返回 ok |

**未做/待办**（避免误以为本期已闭合）：

- **M-C 已落地，但未经真实站点端到端冒烟**：端点与 UI 走 `tsc --noEmit` + 底座单测，
  但"管理员在工厂页点提升 → 工作区 `roles/<id>/SKILL.md` 实际被改写 → git diff 可审"
  这条端到端链路**未在真实运行实例上走过**（同 M-A，属一期末尾同类待办）；
- **M-D 生效验证面板未实现**：目前仍靠人工解压 session jsonl 看注入事件；
  即 M-A 的投递在 UI 上**不可观测**；
- **M-A 未经真实 DSH 冒烟**：单测覆盖 patch 生成逻辑，但"真实会话中
  `agent-instructions` 确被覆写、注入字节数符合预期"仍待跑一次 DSH headless 探针
  （一期末尾原计划项）；
- **§1 迁移项 ② 未做**：`role.json` 尚未缩编（`identity.name` 仍在，人设事实源名义上是
  SKILL.md 但 role.json 仍冗余持有）；
- **§1 迁移项 ① 仅对 sales-chat 闭合**：其余站点角色 `name` 仍为中文。

## 8. 明确不做

- 不引入 Langfuse/Agenta/PromptLayer 等外部 prompt 平台（外部依赖与私有化定位冲突，且不覆盖
  persona 清单语义）；
- 不做 Dify/Coze 式可视化编排（粒度不对，智能体工厂已是承载）；
- 模板级 layer-persona 不加调试功能（模板只接收提炼产物——负责人 2026-10-07 确认）。
