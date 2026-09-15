# dsh 生态共建规划

> 状态：规划（第三步蓝图）。第一、二步已完成，见 §二。
> 相关：`packages/core/src/harness-interop.ts`（家族中立契约）、`packages/dsh-interop`（dsh 家族实现，官方套件唯一落脚点）、`examples/appbase/src/dsh-host.ts`（进程内插件宿主）、`examples/dsh-timem-demo`（插件接入演示）。

## 〇、可替换性承诺（硬约束）

**加入完整 dsh 的目的只是利用其能力，dsh 本身必须可替换。** 结构保证：

- `core` 定义家族中立的 `HarnessInterop` 契约（`family` / `versions()` / `mount()`），不出现任何 dsh 概念；
- `dsh-interop` 是官方套件在本 workspace 的**唯一落脚点**（依赖、锁版本、对齐校验、行装载全部收敛于此）；
- `kernel-*` 纯内核包只依赖 cordis 运行时，零家族套件依赖；
- 换其他 harness 家族 = 新增一个 `<family>-interop` 包实现同一契约，core/layers/AppBase 全部无感。

## 一、定位与北极星

一句话：**借 dsh 的管线，卖我们的场景。**

- 契约主体不变：`KernelAdapter` 等五层契约仍是本项目的主语；dsh（`@deepseek-ai/dsh` 套件）是契约的**首选参考实现**，不是私有依赖。
- AppBase 定位升级：从「自研产品壳」明确为 **dsh 生态之上的产品壳 + 领域插件集**。
- 双向可装载是我们的独特位置：官方 dsh 的能力按「行」装进我们内核；我们的领域能力打包成 `dsh-plugin-*` 装进官方 dsh——两个方向走的是同一条 cordis 插件语言。

## 二、现状（已完成）

| 事项 | 状态 |
|------|------|
| `kernel-dsh` 基于 cordis 4.0.2 实现 `KernelAdapter` | ✅ 已有（36 测试） |
| AppBase 进程内 dsh 插件宿主（懒创建 Context，按注册表装载） | ✅ 已有（timem 插件验证过） |
| core 新增家族中立契约 `HarnessInterop`（可替换性接缝） | ✅ 第二步完成 |
| `@deepseek-ai/dsh@0.1.5-rc.2` + `@dsh-base@0.1.5-rc.2` 精确锁定进 **`dsh-interop`**（官方套件唯一落脚点，kernel-dsh 保持零家族依赖） | ✅ 第二步完成 |
| `DshInterop` 契约实现 + `dshSuiteVersions()`（版本对齐校验）+ `mountDshRow()`（行装载器），6 个测试（契约符合性 + 与内核共存） | ✅ 第二步完成 |
| dsh CLI 可用性（`pnpm --filter @aigility-harness/dsh-interop exec dsh --version` → `0.1.5-rc.2`） | ✅ 第二步完成 |

关键校验：`cordisAligned === true`——本包与 dsh-base 依赖树解析到**同一个 cordis 物理模块**，单运行时保证成立。此校验已固化为测试，升级时若变 `false` 必须先对齐再装载。

## 三、dsh 组装模型（技术依据）

深度接入的原理建立在官方组装模型上，这些是拆包实测结论：

1. **一切皆插件，能力按行编址。** `dsh-base` 包内没有运行时代码，实质是一份 `cordis.patch.yml`（约 60 行 `{id, name, config, disabled}`），每行挂一个官方插件（`dsh-agent`、`dsh-tool-bash`、`dsh-session`、`dsh-sandbox-policy`、`dsh-token-meter`、`dsh-compaction-basic`……）。
2. **三层覆盖，last-write-wins per row。** `dsh-base`（共享核心）→ 模式 bundle（standard/PTC/极简/创造）→ 用户 profile / `--patch` 覆盖。行顺序无加载语义（激活由服务可用性驱动）；每行的 `config` 整体替换而非合并。
3. **`!!js` 求值表达式。** 官方清单里有 `!!js process.env.X ?? 'y'` 这类表达式（如 sandbox 策略、遥测开关）。这是会执行 JS 的配置——**信任边界：只信任官方首包清单，我们自产清单不用 `!!js`**。
4. **`$DSH_HOME` 家目录。** `settings.yaml`（热载，web Models 页写入）、`.credentials.yaml`（托管凭据，前端不回显）、`sessions/`（追加式会话日志）。
5. **遥测。** `session-telemetry-otel` 默认 `FEEDBACK_ONLY` 模式回传 `harness-telemetry.deepseeksvc.com`；`DSH_TELEMETRY_DISABLED`（任意非空值）退出。我们的默认 profile 应当**默认关闭**。
6. **平台自适应行。** bash/pwsh 工具行按 `process.platform` 互斥 disabled，Windows 一等公民——对本项目（Windows 开发机）友好。

## 四、资产 → dsh 插件映射（核心规划）

我们的差异资产按 `dsh-plugin-*` 规范打包，依赖注入走官方服务：

| 资产 | 插件形态 | 依赖的 dsh 服务 | 里程碑 | 验收标准 |
|------|---------|----------------|--------|---------|
| coding-coach（引导教练，最薄的角色） | `dsh-plugin-persona-coach`：system-prompt section + slash command | `dsh-system-prompt` / `dsh-commands` | M2 | 官方 dsh Web UI 装载后可对话，行为与 AppBase 内一致 |
| sales-chat / repair-chat 等角色族 | `dsh-plugin-persona-*` 系列 | 同上 + `dsh-session` | M3 | 同上 |
| app-dev（单文件应用生成） | `dsh-plugin-appdev`：tool-fs 沙箱工作流 + 预览指令 | `dsh-tool-fs` / `dsh-tool-workflow` | M3 | 官方 dsh 内生成单文件应用并在 hall 预览 |
| timem-project-task（需求缓冲→拓扑执行） | `dsh-plugin-timem-task` | `dsh-goal` / `dsh-jobs-local` / timem 插件 | M3 | 汇总→确认→排序执行全链路在官方 dsh 跑通 |
| 计量积分（metering/credit） | `dsh-plugin-metering`：挂在 token-meter 上游记账 | `dsh-token-meter` / `dsh-llm` | M3 | 官方 dsh 会话产生可核算的积分账务 |
| 数据空间（appbase 多协作单元） | `dsh-plugin-dataspace` | `dsh-storage` 域存储 | M4 | 数据空间读写经 dsh 存储栈落盘 |
| plugin-helper（安装引导） | `dsh-plugin-installer` | `dsh-plugin-package-inventory-*` | M4 | 扫描+契约匹配+接入指引在官方 dsh 可用 |

打包规范（所有插件统一）：

- 命名 `@aigility-harness/dsh-plugin-<name>`，入口导出 `apply` + `name`（cordis 约定，与官方一致）。
- `peerDependencies`：`@deepseek-ai/cordis` + 所依赖的 dsh 服务包；**不**打包 dsh 本体。
- 清单不使用 `!!js`；配置经 `config` 注入，保持纯数据。

## 五、反向引入（官方行 → 我们内核）

按需逐行引入，**不**预铺开、**不**引入 dsh 产品壳（web app/CLI 入口）：

| 候选行 | 替代我们的什么 | 引入时机 |
|--------|--------------|---------|
| `dsh-session` + 会话日志 | layer-orchestration 内的会话管理原型 | 会话层重构时 |
| `dsh-tools` + `dsh-tool-*` | layer-action 工具适配的重复部分 | 工具层重构时 |
| `dsh-token-meter` | 计量的 token 统计段 | metering 插件化时 |
| `dsh-compaction-basic` | （暂无对应实现） | 上下文变长的痛点出现时 |

途径：`dsh-interop` 的 `mountDshRow()`（经 core 的 `HarnessInterop.mount` 家族中立入口）逐行装载进我们的 Context；每一行引入都伴随一条 ADR 式记录（为什么引入/替代了什么/退出条件）。

## 六、版本与发布策略

- **锁定**：dsh 套件全部**精确版本**（当前 `0.1.5-rc.2`），禁止 `^`/`~` 漂移。子包与元包取同一版本线（官方 `next` dist-tag 保持套件内自洽）。
- **升级演练**：官方发新版 → 沙箱分支 bump → 跑 kernel-dsh 冒烟（`cordisAligned` 校验在此拦截内核分裂）→ 全量测试 → 记录 breaking 变更 → 决定跟随或跳过。rc 期不追 alpha。
- **发布**：`@aigility-harness/dsh-plugin-*` 发 npm；同时在 GitHub 挂官方生态 topic `dsh-plugin`；每个插件附「官方 dsh + AppBase 双向装载」演示录屏或脚本。

## 七、里程碑

- **M1（✅ 已完成）**：依赖精确锁定 + 桥接原语（版本对齐、行装载）+ 冒烟测试。
- **M2（✅ 已完成）**：① 官方能力库存——`dshBaseRows()` 只读解析 dsh-base 行清单（`!!js` 原文保留不求值）+ admin「DSH 插件」页的「官方能力目录」展示（✅）；② profile 组合器——镜像官方 `applyEntryPatches` 语义（insert / 按 id 覆盖，last-write-wins），bundle 按 `dsh.bundle.patch` 读层，遥测默认硬关闭；`!!js` 白名单求值器（递归下降、只认官方清单出现的形态、不用 eval）；`mountComposedProfile` 按 provide/inject 拓扑序成组装载 + cordis 服务唯一去重（✅，27 测试）；③ 第一个插件 `@aigility-harness/dsh-plugin-persona-coach`——编码教练 system-prompt section + `/coach` 命令，五阶段逐字对齐 AppBase guided-design；headless profile 装载已验证直通 LLM 调用环节，真跑对话验收待 bigmodel 密钥轮换后 `pnpm --filter @aigility-harness/dsh-plugin-persona-coach run smoke`（✅ 装载 / ⏳ 对话验收）。
- **M3**：角色族 + app-dev + timem-task 插件化；metering 挂接 `dsh-token-meter`；npm 首发 + 生态 demo。
- **M4**：数据空间 + installer 插件化；评估是否以官方 dsh 为壳做「开发者发行版」。

## 八、风险与对冲

| 风险 | 影响 | 对冲 |
|------|------|------|
| dsh pre-1.0 破坏性变更（官方明示会有） | 行语义/服务名变动，插件失效 | 精确锁版本；契约隔离（`KernelAdapter` 不动）；升级演练流程 |
| cordis 实例分裂（双运行时） | 插件装载行为不可预测 | `cordisAligned` 校验固化为测试，false 即拒绝装载 |
| `!!js` 表达式执行 | 供应链攻击面 | 仅信任官方首包清单；自产插件不用 `!!js`；组合器白名单求值 |
| 遥测外传（FEEDBACK_ONLY 默认开） | 企业部署合规 | 我们的分发 profile 默认注入 `DSH_TELEMETRY_DISABLED=1` |
| 双前端心智混乱（hall vs 官方 web UI） | 用户困惑 | 定位切分：hall = 终用户产品壳（3419）；官方 web UI = 开发者工作台（3080），不进默认链路 |
| Windows 行为差异 | 工具行不可用 | 官方行已按平台自适应（bash/pwsh 互斥）；关键路径 CI 覆盖 Windows |
