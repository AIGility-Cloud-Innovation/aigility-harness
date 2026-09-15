# @aigility-harness/dsh-plugin-persona-coach

编码教练角色作为**官方 dsh 生态插件**（M2③，见 `docs/dsh-生态共建规划.md` §四）：
分步引导用户设计一个案例应用——只引导、不真正生成/保存任何文件，
最终产出可直接交给「网页应用开发员」的完整提示词。与 AppBase 内
`@persona/coding-coach` + `@orchestration/guided-design` 行为一致（五阶段逐字对齐）。

## 形态

- `systemPrompt.section("persona-coach")`：角色形象 + 五阶段引导法
  （需求理解 → 功能清单 → 页面与数据 → 交互与边界 → 确认与出提示词）
- `commands.register({ name: "coach" })`：`/coach` 命令直接返回引导说明
- 导出 `apply` + `name` (+ `inject`)，cordis 约定，与官方插件一致；
  peerDependencies 只声明 cordis + 所依赖的 dsh 服务包，不打包 dsh 本体；
  配置纯数据，不用 `!!js`。

## 装载

**官方 dsh**（`npx @deepseek-ai/dsh web` 或 CLI）：

```bash
dsh plugin --profile <name> add @aigility-harness/dsh-plugin-persona-coach
# 然后在 profile 的 cordis.patch.yml 用户层补一行:
# - insert:
#     - id: persona-coach
#       name: '@aigility-harness/dsh-plugin-persona-coach'
```

配置项（cordis config，全部可选）：

| 键 | 默认 | 说明 |
|----|------|------|
| `personaText` | 内置编码教练形象 | 角色 section 文本覆盖 |
| `commandName` | `"coach"` | slash 命令名 |
| `sectionOrder` | `0` | section 排序（0 = 官方 DEPLOYMENT_PERSONA_PREFIX 层） |

**headless 冒烟**（一键：装依赖 + 补丁行 + 真跑一次对话）：

```bash
pnpm --filter @aigility-harness/dsh-plugin-persona-coach run smoke -- "我想给班里做个记账本"
# 需环境变量: DEEPSEEK_API_KEY (OpenAI 兼容网关), 可选 DSH_HOME / DEEPSEEK_BASE_URL / DSH_LLM_MODEL
```

验收（规划 §四）：官方 dsh 装载后可对话，行为与 AppBase 内一致——
agent 按「编码教练」形象一次一阶段地引导提问，而不是直接生成代码。

## 类型策略

对官方服务面只取窄的结构视图（对齐 `0.1.5-rc.2` 拆包实测 API），
不 import 官方类型——生态包发布后不把官方类型树拖进 peer 类型解析。
