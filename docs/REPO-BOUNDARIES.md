# REPO-BOUNDARIES — aigility 仓库边界与代码归属规则

> 2026-10-06 定稿。地位：**执行性架构约定**——新功能提交前先过本文的判据；
> 与 `config/project-registry.schema.md`（v2 协作契约）配套：那边管"harness 与
> 业务网站怎么协作"，这边管"代码住哪、谁依赖谁、什么禁止做"。

---

## 一、仓库全景（现状与目标态）

```
┌─────────────────────────────────────────────────────────┐
│ aigility-harness（本仓库）＝ 通用任务管理后台               │
│   packages/          可发布的引擎包（core/五层/rbac/…）    │
│   examples/feishu-task-loop   项目小助理机器人（编排核心）   │
│   examples/team-memory-console 团队记忆日报                │
│   examples/aigility-platform  智悦平台【过渡期留仓，待迁出】 │
│   examples/fde-workbench      FDE 工作台【过渡期留仓，待迁出】│
├─────────────────────────────────────────────────────────┤
│ aigility-platform（未来独立仓库）＝ 业务网站 A              │
│ fde-workbench（未来独立仓库）    ＝ 业务网站 B              │
│ （未来每个网站一个仓库，根部带 harness.yaml，见 v2 规范）     │
└─────────────────────────────────────────────────────────┘
```

- harness 是**平台**不是**库**：有常驻进程（机器人、对齐器、看板后端），
  私有化部署形态 = 一套 harness 编排 N 个业务网站；
- 业务网站（智悦/FDE/未来的站）= 面向具体业务的前后端，通过 harness 的
  包（私有 registry）+ harness.yaml 声明接入。

## 二、依赖方向（单向，不可逆）

```
业务网站 ──依赖──→ @aigility-harness/* 包（私有 registry，0.YYYYMMDD.N）
业务网站 ──声明──→ harness.yaml（v2 规范）
harness  ──执行──→ 业务仓库代码（agentd 克隆、dev 拉 feat/fix 分支）
```

禁止事项：
- ❌ **反向依赖**：harness 的 packages/ 不得 import 任何业务网站的代码/配置；
- ❌ harness 包之间循环依赖（分层 D1→D5 单向）；
- ❌ 站点仓库直接改 harness 包源码——harness 的 bug/需求走 Gitea 工单
  （提到 aigility-harness 仓库），由 harness 侧发版解决。

## 三、提交归属判据（新改动先过这三问）

1. **这个改动会影响多个网站吗？**（或：它依赖任务台账/复核流/对齐器吗？）
   是 → harness 仓库；只影响单一网站的业务行为 → 该站点仓库。
2. **它是"任务管理通用能力"还是"某网站的业务逻辑"？**
   通用（复核、放行、投影、通知、看板、对齐）→ harness；
   业务（页面长什么样、业务接口、站点专属文案）→ 站点。
3. **别的企业/网站用得上吗？**
   用得上 → harness（做成可配置，不硬编码站点名）；
   用不上 → 站点。

边界案例约定：
- `appbase`（登录底座）：**归 harness 发包**，不单独分仓——它是平台无关的认证基础；
- `prototype-mode`：内核原型，**标 private 永不发布**；
- 机器人（feishu-task-loop）的**运维配置页**（TaskLoopConfigPage）：随 harness 走
  （它是 harness 进程的运维面），但看板能力归统一台账看板；
- 站点专属的 LLM 提示词/工作流 yaml：优先放站点仓库（v2 的数据面思想）；
  harness 内置默认只作兜底。

## 四、各仓库内容清单（当前快照）

### aigility-harness 拥有（通用后台）
- `packages/core` 统一任务契约（TaskRecord/UnifiedStatus/TaskProvider）
- `packages/layer-*` 五层引擎（infrastructure/cognitive/persona/orchestration/action）
- `packages/rbac` 权限解析、`packages/role-kit` 角色包、`packages/workflow-studio` 工作流文档引擎
- `examples/feishu-task-loop` 项目小助理机器人（收集→复核→放行→投影→派发全链路）
- `examples/team-memory-console` 团队记忆日报/晨报
- 看板后端（`/api/aigility/registry-tasks` 等只读路由）
- `scripts/publish-packages.sh` 包发布管道（Gitea 私有 npm registry）

### 过渡期暂驻 harness、目标迁出
- `examples/aigility-platform`（智悦平台，React）——迁出触发条件见 §六
- `examples/fde-workbench`（FDE 工作台，React）——同上

### 站点仓库（目标态）应包含
- 业务代码（pages/components/api）
- `harness.yaml`（identity/routing/webhooks 三段声明，见 v2 规范）
- `.npmrc`（指向 Gitea 私有 registry）

## 五、包发布规则

- **发布范围**：`packages/` 下所有非 private 包（13 个）；`prototype-mode` 永不发布；
- **registry**：Gitea 私有 npm（`git.aigility.cloud/api/packages/AIGility-Cloud-Innovation/npm/`），
  零公开暴露；消费侧配置见 `scripts/npmrc.example`；
- **版本方案**：`0.YYYYMMDD.N` 日期版本（同日多发自动递增批次），单调递增；
- **流程**：`scripts/publish-packages.sh`（构建→变更检测→发布→打 `pkg/<name>/<version>` tag）；
- **发布纪律**：影响包契约（core 契约层）的改动必须先跑全量测试再发布；
  发版后向依赖方通告（当前人工，后续可加 Gitea webhook 自动通知）。

## 六、站点迁出（智悦/FDE 分仓）触发条件与流程

触发条件（全部满足才启动某一站点的迁出）：
- ✅ 包发布管道就绪（2026-10-06 已达成）
- ✅ 该站点依赖的全部包已发布且版本可用
- ⏳ 站点自身演进频率显著下降（当前智悦仍在高频演进，FDE 已符合）
- ⏳ 进程耦合解绑（task-loop-manager 对机器人的 spawn 改为 harness 管理端点）

流程（对齐 v2 规范）：
1. `git filter-repo` 剥离站点目录为新仓库（保历史）；
2. 站点 `package.json` 的 `workspace:*` 替换为 registry 版本号；
3. 站点根部提交 `harness.yaml`，harness 扫描登记；
4. 部署外置（独立 dist + systemd + PG schema）；
5. harness 仓库删除对应 examples/ 目录。

顺序约定：**先 FDE（低风险试点）后智悦**（依赖 12 包 + 进程耦合，等管道跑顺）。

## 七、修订规则

- 本文档的修订走 PR 评审（它是架构决策记录，不是随手改的 README）；
- 与 v2 规范（project-registry.schema.md）冲突时以较新者为准，并同步修订另一份；
- 每次仓库边界实质变化（新增顶层目录/新增发布包/站点迁出）必须更新本文 §一/§四。
