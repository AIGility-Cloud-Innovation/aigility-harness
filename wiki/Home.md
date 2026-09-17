# aigility-harness Wiki

> **五域可插拔智能 Agent 架构** —— 一套可承载任何 LLM / 工具 / Agent / 内核的「Harness」工程范式。
> **契约是主体，插件是过客。接口永久不变，实现任意替换。**

- 仓库镜像：[GitHub](https://github.com/AIGility-Cloud-Innovation/aigility-harness) · [Gitea（权威信源）](https://git.aigility.cloud/TiMEM-AI/aigility-harness)
- 本 wiki 与仓库 `docs/`、各包 README 同源；正文修订以仓库为准。

## 📖 导航

### 认识项目

| 页面 | 内容 |
|------|------|
| [[架构与设计理念]] | 五域模型（D1 底座 / D2 认知 / D3 行动 / D4 编排 / D5 人格）、四种运行载体、原型↔生产双形态、Seam 契约热替换——README 白皮书部分同源 |

### 上手与部署

| 页面 | 内容 |
|------|------|
| [[快速开始]] | 环境要求、安装、构建/测试、原型演示、AppBase 应用大厅、企微→Codex 特色案例 |
| [[启动与部署指南]] | 本机日常启动速查 · 端口/环境变量配置参考 · **从零部署踩坑全记录**（Node 便携版 PATH、pnpm 版本、PG、企微 readEnvLayer 保留变量、PowerShell 执行策略…）· 换机迁移最短路径 |

### 接入案例

| 页面 | 内容 |
|------|------|
| [[案例-企微接入DSH]] | 企微 @机器人 → `dsh --profile headless` 会话中继（配置 / 指令 / 多轮滚动上下文 / 边界） |

### 设计文档（docs/ 同源）

| 页面 | 内容 |
|------|------|
| [[设计-企业微信接入]] | wecom-chat 设计：复用 wecom-ingress 的零新框架代码接入方案（§5 含 wecom-dsh 现状） |
| [[设计-飞书入口]] | feishu-ingress 设计（**已实现**：`layer-infrastructure/src/feishu-ingress.ts`） |
| [[设计-应用管理]] | AppBase 账号 / API Key / 用量监控 |
| [[设计-插件集成]] | 插件集成设计（plugin-integration） |
| [[设计-任务编排工作流]] | 任务意图识别 + workflow-engine 编排 |
| [[设计-PolicyAgent]] | 策略型 Agent 设计 |
| [[DSH-生态共建规划]] | 反向生态插件路线：dsh-interop / persona-coach / M1-M4 里程碑 |

## 🧭 一图速览

```text
外部信号 → D1 ingress 收口 → ① D5 人格 → ② D4 编排 → ③ D2 认知 → ④ D3 行动 → 响应
（调用流域号严格递减 5→4→2→3，与依赖序同向；每域只依赖比自己小的域号）
```

```text
packages/
├── core/                 # 契约与内核抽象（ServiceDefinition / Provider / Consumer / CarrierKind）
├── kernel-dsh/           # DSH-Cordis 内核适配（插件生命周期 / DI / 事件溯源）
├── layer-infrastructure/ # D1 底座：http-ingress / wecom-ingress / feishu-ingress / http-relay / PgBusBridge
├── layer-cognitive/      # D2 认知：llm-inference / memory（电站，只供算力）
├── layer-action/         # D3 行动：codex/zcode/claude 编码工人 / TTS / 工具执行
├── layer-orchestration/  # D4 编排：workflow-engine / timem-project-task / guided-design
├── layer-persona/        # D5 人格：sales-chat / app-dev / coding-coach / timem-* 等具名角色
├── dsh-interop/          # 官方 DSH 能力目录 / profile 组合器
├── dsh-plugin-persona-coach/ # 首个反向生态插件（编码教练 section + /coach 命令）
├── py-bridge/            # Python 生态声明式接入（aigility ADK）
└── prototype-mode/       # 原型演示入口

examples/                 # 可替换示例装配：appbase（产品装配）/ wecom-chat / wecom-coder /
                          # wecom-dsh / wecom-guide / wecom-timem / feishu-timem /
                          # openai-gateway-composition / dsh-timem-demo
```

## 🔧 维护约定

- 本 wiki 各页面源自仓库内文档，**改文档请改仓库**（README / docs/），wiki 同步刷新。
- 部署踩坑一律记入 [[启动与部署指南]] 第三部分（坑 1-10），换机迁移照「最短路径」执行。
