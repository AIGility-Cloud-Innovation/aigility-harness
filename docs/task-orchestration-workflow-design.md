# 编排层工作流设计：任务判定 → 归仓 → 派发执行

> 状态：**设计稿，待评审**
> 位置：`aigility-harness/packages/layer-orchestration`
> 目标：让「入口消息 → 任务执行」走正确的三段式工作流，替代现在的
>       「任何消息直接建任务 + 固定 standalone」

---

## 1. 背景与问题

当前链路（已工作但有缺陷）：

```
飞书消息 → ingress → 人格 → @orchestration/timem-task
   → POST /v1/tasks（固定 confirm standalone）→ agentd run → git fetch 崩
```

缺陷：
1. **没有任务判定**：「你好」「在吗」也会建任务 → agentd 空转执行
2. **没有归仓**：全部固定 standalone，不识别「在 gyzy_platform 修 bug」
3. 执行引擎默认项目是 git 仓库（fetch origin/dev），standalone 空 repo 直接秒失败

**正确形态**（用户拍板）：编排层工作流先判定「是不是任务」→「归哪个仓库」→ 再派发执行。

## 2. 实现载体选择

harness 编排层现有两种形态，**本设计选「TimemTaskProvider 内部状态机」**：

| 载体 | 评估 | 结论 |
|---|---|---|
| workflow-engine stub 扩充 | stub 是确定性占位，P... | ✗ 架构方向是 py-bridge 换 LangGraph，不适合塞 TS 业务 |
| **timemTaskProvider 内做三段式** | 它就是真实执行桥接，三段式天然属于它的职责 | ✅ |
| 新开 @orchestration/task-orchestrator | 多一个 hop，装配示例要改 | ✗ 过度设计 |

## 3. 工作流状态机

```
execute(TimemTaskRequest)
  │
  ├─ ① classify（编排层内，不调 agentd）
  │    规则快速判定：
  │    - 非任务关键词（你好/谢谢/在吗/辛苦了/好的/收到）→ CHAT
  │    - 任务意图词（执行/修复/改/建/开发/跑/测试/更新/排查/部署/在X项目…）→ TASK
  │    - 两者都不含 → 调 @cognitive/llm-inference 让模型分类（prompt: 是否是任务+项目名）
  │    → 返回 CHAT | TASK | UNCLEAR
  │
  ├─ ①a  CHAT → return ok({type:"chat", text: 闲聊回复策略})
  │        策略1：调用 llm-inference 生成闲聊回复（需 llm 可用）
  │        策略2：固定回复「我在的，有什么任务需要我执行吗？」（零依赖兜底）
  │
  ├─ ①b  UNCLEAR → return ok({type:"ask", text:"你希望我做什么呢？可以描述为一个任务…"})
  │
  ├─ ② identify（归仓）
  │    projectId 已显式传入（request.project_id）→ 用之
  │    否则：
  │      - 消息含项目名 → 提取候选（LLM 或规则：/在([\w-]+)项目/）
  │      - 调 agentd POST /v1/tasks/identify-project（resolveProject 四连）
  │      - 返回 projectId | 空
  │    → 空 → return ok({type:"ask", text:"这个任务要归到哪个仓库？…"})
  │
  ├─ ③ dispatch（派发执行）
  │    create-from-message（带 projectId）→ confirm（如 pending）→ run → 轮询
  │    → return ok({type:"task", task_id, status, response})
  │
  └─ 异常处理：
       agentd 不可达 → ok({type:"error", text:"执行引擎未就绪…"})
       UDS 错误 → 降级提示（不 panic）
```

## 4. 接口形状（TimemTaskRequest/Response 扩展）

```ts
// Request 新增
project_id?: string;        // 显式归仓
conversation_id?: string;   // 会话（绑定时用）
chat_type?: string;         // p2p | group
resources?: ResourceRef[];  // 图片等

// Response 改为判别联合
type TimemTaskResponse =
  | { type: "chat";     text: string }                        // ①a 闲聊
  | { type: "ask";      text: string }                        // ①b/② 反问
  | { type: "task";     task_id: string; status: string;
      response: string }                                      // ③ 任务结果
  | { type: "error";    text: string };                       // 异常
```

## 5. 判定规则集（① classify）

**规则层（先跑，零成本）**：
```ts
const CHAT_ONLY = /^(你好|hi|hello|在吗|谢谢|辛苦|好的|收到|嗯|哦|在|哈喽)$/i;
const TASK_VERBS = /(执行|修复|修改|改|创建|新建|开发|实现|跑|运行|测试|部署|排查|更新|删|清理|检查|验证|告诉|生成|写|分析|重构|迁移)/;
const PROJECT_PATTERN = /在\s*([\w\-\.\/]+?)\s*(项目|仓库|repo)/;
```

**LLM 层（规则判不了时）**：调 `@cognitive/llm-inference`
```
prompt: 判断下面用户消息是否是「要 AI 执行的任务」。
        如果是，提取其针对的项目/仓库名（如有）。
        输出 JSON {is_task: bool, project: string|null, reason: string}
```

## 6. 归仓顺序（② identify，与 agentd resolveProject 一致）

1. `request.project_id` 显式传入 → 用
2. 会话绑定（conversation_bindings 表，agentd 侧查）→ `identify-project` 返回
3. 消息含项目名 → LLM/规则提取 → `identify-project` 复核
4. 都没有 → 反问用户

**5. git 有效性校验（归仓后、派发前，关键新规则）**：
   确认项目后，agentd 在 identify-project（或 create-from-message 确认前）校验
   目标项目的 root_path 是否为有效 git 仓库（`git rev-parse --is-inside-work-tree`）：
   - 有效 → 继续派发
   - 缺 git（空仓库/无 .git/无 origin 远程）→ 返回**类型化错误**：
     ```json
     { "type": "error",
       "text": "项目「{name}」不是有效的 git 仓库（{原因}），无法执行任务。
               请先将该目录初始化为 git 仓库并配置远程。" }
     ```
   - **绝不带着坏 git 去派发执行**——执行引擎只在归仓+git 双校验通过后才碰 git

## 7. 装配与依赖

- **插件**：timem-task 逻辑不变（仍独立文件），其 execute 内部按状态机走
- **新依赖**：`llm-inference`（@cognitive/llm-inference，编排层 manifest 的 consumes 已声明）
- **agentd 新增**：`POST /v1/tasks/identify-project`（薄封装 resolveProject，输入 text/conversation_id/sender_id 输出 projectId/confidence/method）
- **示例装配**：feishu-timem 示例已在调用 timem-task，无需改路由；persona 改为透传原样（不再组织载荷，只加 user_id/session_id）

## 8. 验收标准

1. 飞书发「你好」→ 回闲聊回复，**任务表无新增**
2. 飞书发「在 Standalone 项目执行 echo hello」→ 归仓 standalone → 建任务 → 执行（此步待 git 问题修复后完整验证）
3. 飞书发「在 gyzy_platform 修 bug」→ 归属 gyzy_platform（需先注册该仓）
4. 无项目名任务 → 反问「归哪个仓库」
5. agentd 未起 → 「执行引擎未就绪」降级提示
6. 单测：classify 规则（/你好→chat /执行→task /无关键词→llm），identify 顺序（显式→绑定→项目名→反问），dispatch 决策表
7. **项目缺 git → 返回「不是有效 git 仓库」类型化错误，不派发执行**（新规则，含跨端验证：识别到 standalone 但 workspace 无 git → 明确报错，任务表不新增 failed 记录）

## 9. 依赖的前置问题

- **执行引擎 git 崩溃**（standalone 空 repo fetch origin/dev 失败）——**已被本节新规则 6-5 拦截**：归仓后先查 git 有效性，缺则类型化报错，不再让执行引擎碰坏 git。剩余情况（git 有效但缺 origin/dev 远程）仍会 fetch 失败——这是**执行引擎适配**（B 方案 engine 退化 or C 方案换真 git 仓库 root）的第二层问题，不在本设计范围，但可在归仓校验时同时检查 `git remote -v` 有 origin 与目标分支，一并纳入错误信息
- **agentd 当前 run 秒失败**：same root cause

## 10. 工作量

- timem-task.ts：~120 行（status machine + classify rules + identify 编排）
- agentd http.go：identify-project handler ~30 行
- 单测：~80 行
- 联调：0.5 天