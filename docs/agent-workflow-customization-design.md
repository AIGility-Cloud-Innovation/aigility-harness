# 智能体工作流定制设计（用户在智悦平台优化 agent 工作流 + RSI 自优化）

> 状态：设计（待评审，未实施）
> 相关：`examples/aigility-platform/src/role-registry.ts`（角色能力注册表）、`packages/dsh-interop/src/session-relay.ts`（patch overlay 生成）、`packages/dsh-plugin-persona-coach/src/index.ts`（persona 注入先例）、`docs/角色通道声明模型设计.md`（角色五要素）、`docs/AI治理路线图.md`（G4-3 策略即代码）
> 本文所有机制断言均附实测出处（文件:行号）。**[实测]** = 已跑过命令看到输出；**[推测]** = 推理，未验证，不要在其上施工。

---

## 〇、问题陈述：缺口在"能力面"，不在"persona 面"

用户诉求有两半，先把它们分开，因为**它们的成熟度完全不同**：

| 诉求 | 现状 | 缺口 |
|------|------|------|
| A. 用户主动优化 agent 工作流 | 平台已有「角色能力注册表」，可配技能 + MCP | **只能配"给什么工具"，不能配"怎么做事"** |
| B. RSI 帮 agent 优化工作流 | `site-improver` 已有「意见 → 任务 → 编码代理改码 → 人审」闭环 | **闭环的标的是平台网站，不是 agent 自身行为** |

**一句话概括缺口**：今天的注册表是**能力面**（skills / mcpServers），而"工作流"落在**行为面**（persona 文本 / AGENTS.md / 纪律条款）。**能力面已接线，行为面零接线。**

### 为什么"persona 可以定制"这个前提只对了一半

用户说"我们已经有一个 harness 项目，可以定制 persona"。**这句话是对的，但项目里有两种同名不同物的 persona，必须区分**：

| | 载体 | 作用域 | 是否进系统提示词 |
|---|---|---|---|
| **引擎级 persona** | `deployment:persona` 槽位（order 0）；`persona-coach` 插件的 `personaText` 配置 | 单个 DSH 会话的行为契约 | ✅ 是 |
| **应用级 persona** | `packages/layer-persona`（`@persona/sales-chat`、`@persona/coding-coach`…14 个 Provider） | 业务角色形象（业务 Prompt 在各自 `.ts` 里写死） | ❌ 否，是业务代码 |

**[实测]** `packages/layer-persona/src/index.ts` 的 manifest 声明 `name: "@persona/character"`，提供 14 个业务 Provider；其文本是**源码常量**，不是每次会话注入的部署人格。
**[实测]** `examples/aigility-platform/src/index.ts:164-174` 的市场页 persona 清单来自**这张业务 Provider 表**。

所以"平台能定制 persona"**目前指的是应用级**——改它需要改代码 + 重新构建。**用户要的是引擎级**——改完即时生效、不必重新发布。**这两者之间就是本设计要建的桥。**

---

## 一、机制盘点：今天能改什么、改不动什么

### 1.1 已有的三条真实通路（全部 [实测]）

**通路①：角色能力注册表（热生效，仅能力面）**

`examples/feishu-dsh/roles.json` → 每条消息热读取 → 生成 `--patch` overlay 注入 headless。
**[实测]** `examples/aigility-platform/src/role-registry.ts:1-11` 的注释即此语义："每条消息热读取并生成 --patch overlay 注入 headless（改完即生效，无需重启）"。
**[实测]** `packages/dsh-interop/src/session-relay.ts:132-168` `buildRolePatchFile()` 实际只产出**两类** patch 条目：
- `{ id: "skill-filesystem", config: { customSkillDirs } }` —— 有 skills 时；
- `{ insert: [...@deepseek-ai/dsh-mcp-client] }` —— 每个 mcpServer 一条。

**这就是缺口的精确定位**：该函数**没有任何分支**产出 `dsh-agent-instructions` 或 `systemPrompt` 相关条目。**行为面在这条通路上完全没有出口。**

**通路②：persona 注入（可注入，但没接平台）**

**[实测]** `packages/dsh-plugin-persona-coach/src/index.ts:116-131`：
```ts
export function apply(ctx: PluginContext, config: PersonaCoachConfig = {}): () => void {
  const personaText = config.personaText && config.personaText.trim().length > 0
    ? config.personaText
    : DEFAULT_PERSONA_TEXT;
  const disposeSection = ctx.systemPrompt.section({
    name: "persona-coach",
    order: config.sectionOrder ?? 0,   // 0 = 官方 deployment:persona 层
    text: personaText,
  });
```
**[实测]** 同文件 `inject = ["systemPrompt", "commands"]`；`PersonaCoachConfig.personaText` 是**纯数据配置**。

**这条极其重要**：它证明「**配置驱动的 persona 文本 → order 0 系统提示词槽位**」的完整链路**在框架内已经跑通并已打包**，且 `personaText` 走的是插件 config（纯数据，不用 `!!js`）。
**它唯一的缺陷是：这个 config 是静态的（build/装载期），没有任何平台侧写入路径。**

**通路③：AGENTS.md 装载器（就位，但候选全空）**

**[实测]** `node_modules/.pnpm/@deepseek-ai+dsh-agent-instructions@0.2.0-rc.2.../lib/index.js:17-18`：
```js
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];
```
**[实测]** 同文件 `:141` `const USER_GLOBAL_FILE = "AGENTS.md";`，`:148` 识别 `~/.dsh/AGENTS.md` / `$DSH_HOME/AGENTS.md` 为用户全局层，`:756` 给出该路径显示名。
**[实测]** 装载器挂载于 `dsh-base`，`maxBytes: 65536`（`docs/token-saving-cheatsheet.md:42` 与 `:244` 互相印证）。
**[实测]** 仓库根 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md` **均不存在**（三条 `ls` 报错）。

**结论**：装载器、候选表、用户/项目/本地三层叠放规则**全部就位**，缺的只是**文件本身**与**写文件的通路**。

### 1.2 关键判定：两条落点，该选哪条

| | 落点 A：`AGENTS.md` 文件 | 落点 B：`systemPrompt.section` 注入 |
|---|---|---|
| 机制 | 装载器读文件 | 插件 registry 注册 section |
| 生效方式 | 文件内容变化 → 下次装载读到 | 装载时注入（persona-coach 的 config 是装载期） |
| 可分层 | ✅ 用户全局 / 项目 / 本地 三层叠加 | ❌ 平铺 |
| 可提交可评审 | ✅ 进 git、可 PR、可 diff | ❌ 配置在 profile/装载点 |
| 用户可读可改 | ✅ 纯 markdown | ❌ 需走平台 UI |
| 已有先例 | 无（文件从不存在） | ✅ persona-coach 已跑通 |
| 与生态惯例一致 | ✅ Claude Code / Codex 同款 | 厂商私有 |

**建议：以 A 为主落点，B 作为 A 不可用时的兜底。**

理由：
1. **A 天然支持"用户主动优化"**——用户能直接读、能 diff、能版本化自己的行为契约，这本身就是可审计性（对齐 `AI治理路线图` G4-3「策略即代码：规则打底、变更留痕」）。
2. **A 的分层规则与角色模型同构**——用户全局纪律 / 项目纪律 / 角色纪律，正好对应"平台级 → 站点级 → 角色级"三级作用域。
3. **B 的先例证明通路可行，但 config 是装载期静态的**，要让平台写它，得改 patch overlay 生成逻辑（`buildRolePatchFile`），**而 A 只需写文件**，改动面更小、风险更低。

**不选"直接改 layer-persona 源码"**：那是应用级 persona，改它是改代码 + 重新构建，**违背"用户主动即时优化"的诉求本身**。

---

## 二、设计：三级作用域 + 一条热生效写路径

### 2.1 三级作用域（对应 AGENTS.md 三层 + 角色声明）

```
① 平台级（智悦默认工作流）   → $DSH_HOME/AGENTS.md        由平台管理员维护，全站点生效
② 站点/角色级（角色纪律）     → <站点>/AGENTS.md 或角色目录   由角色 owner 维护（roles.json 声明）
③ 用户级（个人偏好）         → <站点>/AGENTS.local.md      由终端用户维护，最高优先级
```

**[实测]** ①的路径由 `USER_GLOBAL_FILE` + `dshHomeDisplay` 定义（`lib/index.ts:141,756`），**不是臆造的路径**。
**[实测]** ②③的候选文件名由 `DEFAULT_INSTRUCTION_FILE_CANDIDATES` / `DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES` 定义（`:17-18`）。
**[实测]** `.local` 与 base 是「overlay」关系（`:157` 注释原文：`AGENTS.md vs CLAUDE.md, a base file vs its .local overlay`）。

**叠放语义**：装载器逐目录向上叠放，越近越优。因此：
- 用户想覆盖平台的某条纪律 → 写③，**不改他人文件**；
- 平台想全局约束 → 写①，用户③仍可覆盖（**这个优先级顺序需要评审确认**：是"平台硬约束 > 用户偏好"还是反之？见 §六 待决项 1）。

### 2.2 新增写路径：注册表 v3 增加 `instructions` 段

**在 `RoleCapabilityConfig` 上增加一个字段即可，不改现有两类能力**：

```jsonc
{
  "skillsRoot": "skills",
  "roles": {
    "baojing-analyst": {
      "label": "报警研判助手",
      "skills": ["baojing-analyst"],
      "mcpServers": [ /* …不变… */ ],

      // ── 新增：行为面声明（本设计增量）──
      "instructions": {
        // 方式一：引用一个可版本化的文件（推荐）
        "file": "instructions/baojing-analyst.md",
        // 方式二：内联短文本（平台 UI 直接编辑用）
        "inline": "研判结论必须标注证据来源；不确定时输出『未定位』而非推测。",
        // 合并策略：append 追加到平台级之后 / replace 替换本层
        "mode": "append",
        // 上限（防御性，见 §四）
        "maxBytes": 16384
      }
    }
  },
  "routes": { /* …不变… */ }
}
```

**`RoleCapabilityConfig` 的改动**（`examples/aigility-platform/src/role-registry.ts:38-43` 现状为 `label? / skills? / mcpServers?`）：
- 新增 `instructions?: RoleInstructions`（向后兼容：缺省＝无行为面约束，行为完全不变）；
- `validateRole()` 增加 `instructions` 校验（`file` / `inline` 二选一，`maxBytes` 数值范围，路径必须落在 `registryDir()` 之内——**防路径穿越**）。

**为什么放在注册表里**：注册表已经是「**单一事实源**」（**[实测]** `role-registry.ts:4-6` 注释即此措辞），且已完成「**每条消息热读取**」。**把 `instructions` 挂进同一个文件，就免费继承了热生效语义**，无需新建第二条装配链路。这符合 `docs/角色通道声明模型设计.md` 的「部署 = 改声明」原则。

### 2.3 热生效的实现落点

**[实测]** `buildRolePatchFile()`（`session-relay.ts:132`）目前返回 `null` 表示"无能力不产出文件，零开销"。

**增量**：在该函数内，当 `role.config.instructions` 存在时，追加一条 patch entry，指向一个**渲染出的 AGENTS.md**：

```ts
// 伪码：与现有 skillDirs / servers 两分支并列的第三分支
if (role.config.instructions) {
  const outMd = renderRoleInstructions(reg, role, path.join(dirname(outFile), `${role.id}.AGENTS.md`));
  // 落点二选一，见下
}
```

**两种接法（需评审选定）**：

- **接法 α（写文件，推荐）**：把渲染结果写入角色专属目录的 `AGENTS.md`，并让会话的工作目录/cwd 指向该目录。**优点**：完全走既有装载器语义，无新机制。**缺点**：依赖 cwd 与"逐目录向上叠放"的交互，需要实测确认叠放边界（**未验证**）。
- **接法 β（改 patch 注入 instructions 行）**：在 patch 里加一条 `dsh-agent-instructions` 的 config 覆盖，把 `instructionFileCandidates` 指向渲染出的绝对路径。**优点**：不依赖 cwd。**缺点**：需要确认该行可被 patch 覆盖（**[未验证]** —— 装载器 schema [实测] 有 `instructionFileCandidates` 字段（`lib/index.js:30`），但**在 patch 中覆盖该行的 id 尚未核实**）。

> **诚实标注**：α / β 二者我都**没有实测验证过**。选型前必须先用一个最小会话验证「patch 重叠 → 候选路径 → 实际注入字节」的完整链路。**这是本设计第一个必须补的实验**（§六 待决项 2）。

### 2.4 平台 UI 面

在现有「角色能力配置」页（**[实测]** `examples/aigility-platform/app/src/lib/harness.ts:232` 已有真接口区）**并列加一个"工作流纪律"编辑器**：

| 区块 | 现状 | 增量 |
|------|------|------|
| 技能 | ✅ 已有 | 不变 |
| MCP | ✅ 已有 | 不变 |
| **工作流纪律** | ❌ 无 | **新增**：markdown 编辑器 + 生效范围选择（角色/站点/个人）+ 差异预览 |
| **生效验证** | ❌ 无 | **新增**：显示"当前会话实际注入的纪律字节数 + 来源"，与 `docs/token-saving-cheatsheet.md` 的 token 口径对齐 |

**"生效验证"这一项不是锦上添花，是本设计的核心验收件**——它直接回应此前反复出现的失败模式：**契约写下了，但没人知道它到底有没有进系统提示词**。
**[实测]** 该失败模式有真实先例：`dsh-agent-instructions` 装载器就位、候选表首位是 `AGENTS.md`，**但文件从不存在，注入零字节，且长期无人察觉**。

---

## 三、RSI 闭环：让"我"能优化"我"

### 3.1 现有闭环（已跑通）与它的标的错位

**[实测]** `examples/aigility-platform/src/site-improver.ts:1-13` 的注释描述了一个完整闭环：
> 意见聊明确后自动落任务板（executor=code）→ 自动派发 ZCode 编码代理改代码 → review 人审后生效

**这个闭环的标的是"平台网站"，不是"agent 行为"。** 用户说"网站这里不好用"，它改前端；用户说"你上次不该先断言后验证"，**它无处安放**——因为行为面没有可写的落点（§1.1 已证）。

**所以 RSI 那半的缺口不是"没有闭环"，是"闭环没有接上行为面这个靶子"。**

### 3.2 增量：把行为面接进同一个闭环

复用 `site-improver` 的**机制**（意见 → 澄清 → 任务 → 编码代理 → 人审），只**换标的与产物**：

```
用户反馈（自然语言："你老是先断言后验证"）
   ↓
RSI 分诊器：判断这是「平台缺陷」还是「行为缺陷」
   ├─ 平台缺陷 → 走既有 site-improver（改前端代码）── 不变
   └─ 行为缺陷 → 走新增 workflow-improver：
        ① 归因：这条反馈属于哪个作用域？（平台级/角色级/用户级）
        ② 起草：生成一条可执行纪律（markdown），而非一句抱怨
        ③ 落盘：写入对应 AGENTS.md 层（或 roles.json。instructions）
        ④ 验证：下个会话读取「注入字节数 + 来源」，确认真的进去了
        ⑤ 人审：与 G1-2 审批闸门对齐 —— 未经批准不写入平台级
```

**关键设计约束（吸取教训）**：**步骤④是必须的，不是可选的。**
本次设计的前置调查中，已经出现「纪律写了但从未生效、且长期无感知」的真实案例（**[实测]** AGENTS.md 从不存在）。**一个不验证注入结果的 RSI 闭环，会把"写给空气"自动化成"大批量写给空气"。** 因此⑤之前必须有④，④不通过则回滚并标记失败——**不允许假成功**（对齐 `AI治理路线图`：「降级显式标记，拒绝假成功」）。

### 3.3 归因器：把"抱怨"转成"纪律"的关键一步

**这是最容易做错的一环，也是本设计里我唯一必须标 [推测] 的部分。**

反馈 → 纪律的转换，需要一个能判断"这条反馈该落在哪一层、以什么措辞"的组件。**它的设计质量决定整个 RSI 闭环是有用还是有害**：
- 落错层：用户个人抱怨被写进平台级，污染所有人；
- 措辞错：写成"要更小心"这种无法执行的空话（本次对话的历史里，这类空话已被证明无效——"我下次会更小心"反复失效）；
- 过度抽象：把一次性事件升格为永久纪律，导致行为僵化。

**建议**：归因器先以**人工模板 + LLM 起草 + 强制人审**的最小形态落地，**不做全自动**。理由：
- 全自动的前提是有可靠的评估信号，而"纪律是否改善了行为"目前**没有度量**（见 §3.4）；
- 负面纪律（"不要做 X"）的验证成本远高于正面纪律。

### 3.4 度量：RSI 闭环的缺失件（诚实标注）

**一个优化闭环如果没有度量，就不是闭环，是"改完就算"。**

现状：**没有任何机制度量"纪律生效后行为是否真的变好"。** 可用的替代信号及其局限：

| 候选信号 | 可得性 | 局限 |
|---|---|---|
| 注入字节数 / 来源 | ✅ 可立即做（§2.4） | 只证明"写进去了"，不证明"行为变了" |
| 会话转录人工评审 | ✅ 已有 `.state/transcripts.json`（**[实测]** 存在） | 不可扩展、有主观性 |
| 违反纪律的自动检测 | ❌ 需新建 | 需要定义"可检测的纪律"子集 |
| 任务成功率 / 重试率 | [推测] 可能在 `dsh-token-meter` 类插件里有 | **未核实，不要引用** |

**建议**：把"可检测的纪律"作为一等公民——**只把能自动检测的条款写进①平台级**，无法检测的（如"要诚实"）留在③用户级作为软约束。这样度量与纪律同源，闭环才闭合。

---

## 四、治理对齐（硬约束，不可绕过）

按 `AI治理路线图` 与新场景准入五条：

| 准入条 | 本设计的对应 |
|--------|-------------|
| 走 D1 收口入口 | 写路径统一走 `role-registry.ts`（已是单一事实源），不新增第二条写入口 |
| 接平台账号 + 审计留痕 | 每次 `instructions` 变更记 `changed_by / changed_at / diff`；对齐 G4-3「变更留痕」 |
| 高风险动作有闸门 | **平台级①的写入必须人审**（G1-2）；用户级③可自助 |
| 降级显式标记 | 无法验证注入 → 显式报"未生效"，**拒绝静默成功**（§3.2 步骤④） |
| 密钥不入库 | `instructions` 是纯文本纪律，**明文禁止出现任何凭证**；`validateRole()` 加凭证模式扫描 |

**额外防御（来自本次调查的真实教训）**：
1. **`maxBytes` 上限**——装载器有 `65536` 上限（**[实测]** cheatsheet:42），平台侧应设**更小**的默认值（建议 16KB/角色），避免角色纪律挤占上下文。**越界必须显式报错，不能静默截断**（静默截断正是"写进去了但没生效"的温床）。
2. **路径穿越防护**——`instructions.file` 必须 `resolve()` 后校验落在 `registryDir()` 之内。
3. **凭证扫描**——纪律文本误贴 API key 是高概率事故（**[实测]** 现存 `roles.json` 中已有内联 `X-API-Key` 明文，说明这个习惯是真实的）。

---

## 五、分期实施

| 期 | 内容 | 验收线 | 依赖 |
|---|---|---|---|
| **P0 验证** | 最小实验：patch overlay → AGENTS.md → 确认注入字节（§2.3 α/β 选型） | 能打印"实际注入 N 字节，来源 M" | 无（**当前唯一硬阻塞**） |
| **P1 平台级①** | 建 `$DSH_HOME/AGENTS.md`；平台页可编辑 + 显示注入字节 | 改完下个会话生效，字节数可见 | P0 |
| **P2 角色级②** | `roles.json` v3 `instructions` 段；`validateRole()` 校验；渲染 → 落盘 | 配一个角色纪律，验证生效 | P1 |
| **P3 用户级③** | `AGENTS.local.md` 编辑入口；优先级语义确定 | 用户覆盖平台纪律，且可回滚 | P2 |
| **P4 RSI 闭环** | workflow-improver：分诊 + 起草 + 落盘 + **验证** + 人审 | 一条真实用户反馈走完全程 | P3 + G1-2 |
| **P5 度量** | 可检测纪律子集 + 违规检测 | 能回答"纪律生效后违规率是否下降" | P4 |

**与既有路线图的接口**：P4 依赖 G1-2（人审闸门）；P5 与 G4-3（策略即代码）合流；P1-P3 是 `docs/角色通道声明模型设计.md` 五要素中 `identity.prompt_ref` 的**引擎级实现**——该文档的 `prompt_ref: skill:baojing-analyst` 走的是技能路径，**本设计补的是它旁边空着的"纪律路径"**。

---

## 六、待决项（需用户/评审拍板，我不擅自定）

1. **优先级语义**：平台级①与用户级③冲突时谁赢？
   - 选项 A：用户优先（③ > ①）——尊重个体，但平台硬约束可被绕过；
   - 选项 B：平台优先——安全，但用户无法自助纠偏；
   - 选项 C：**分级**——平台级分"硬约束"（不可覆盖，如安全红线）与"默认值"（可被③覆盖）两段。**我倾向 C**（对齐 `AI治理路线图`「治理不牺牲原型速度」），但这需要产品决策。
2. **α vs β 接法**（§2.3）：必须先跑 P0 实验，我不能在未验证的机制上出结论。
3. **归因器自动化程度**（§3.3）：建议先全人审，何时放开、依据什么信号放开？
4. **是否允许用户级纪律跨站点携带**——用户在一个站点写的偏好，到另一个站点是否生效？

---

## 七、风险

| 风险 | 影响 | 对冲 |
|---|---|---|
| patch overlay 无法覆盖 instructions 行 | β 方案不成立 | **P0 先验证**；退到 α |
| 纪律膨胀挤占上下文 | 有效上下文减少，反伤性能 | `maxBytes` + 平台页显示字节占用（对齐 token 预算视角） |
| 平台级被写入低质量纪律 | 污染所有角色 | 强制人审 + 平台级仅收"可检测纪律"（§3.4） |
| RSI 把"写给空气"自动化 | 大批量无效纪律，且无人察觉 | **④验证为强制步骤**，不通过则回滚 |
| 与 `layer-persona` 混淆 | 用户以为改了 persona 实际改了业务代码 | 平台 UI 明确区分两个概念（§〇） |

---

## 八、本文的诚实边界

- **[实测] 已核实**：装载器候选表与用户全局路径（`lib/index.js:17-18,141,148,756`）；`buildRolePatchFile` 只产出两类条目（`session-relay.ts:132-168`）；`persona-coach` 的 order 0 注入与 `personaText` 配置（`index.ts:116-131`）；平台 market 清单来自 `layer-persona` 业务 Provider（`index.ts:164-174`）；注册表热读取语义（`role-registry.ts:1-11`）；`site-improver` 闭环标的为平台网站（`site-improver.ts:1-13`）；`roles.json` 存在内联明文 key。
- **[推测] 未验证，不要据其施工**：α / β 两种接法能否工作；`dsh-agent-instructions` 行能否被 patch 覆盖；"逐目录向上叠放"在角色专属 cwd 下的实际边界；任务成功率类度量信号的可得性。
- **本轮未写任何记忆，未落盘任何配置改动**——本文仅是设计文本。