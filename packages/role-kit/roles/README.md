# packages/role-kit/roles/ — 出厂角色模板库

> **定位**：随底座分发的公共角色模板（git 版本化，只读）——`role-kit = 格式 + 加载器 + 出厂模板`。
> **站点角色事实源不在这里**：各网站写自己的 `examples/<site>/data/roles/`（gitignored 站点状态，
> 同 id 站点优先）。工厂编辑公共角色 = copy-on-override 复制到站点层再改，底座原件永不被网站改写；
> 「恢复出厂」= 删除站点定制版，解析自动回落本目录。

## 角色包格式（v1）

一个角色 = 一个目录，两份文件：

```
<role-id>/
  SKILL.md    # 人设：frontmatter（name / description）+ 正文 = 角色 Prompt（DSH/agent-skills 惯例，原生可读）
  role.json   # 五要素声明：identity / sources / actions / outbound / memory（schema 见 @aigility-harness/role-kit）
```

约定：
- `role_id` = 目录名 = persona key = 记忆域（memory.agent_id 恒等于 role_id）；
- `sources.channels` 可选——不声明即纯网页/后台角色（通道绑定可选, 基线 1）；
- `actions.commands`（确定性命令/意图表）与 `actions.schedules`（调度器声明，enabled=false 即旁路）可选；
  调度器的运行面配置（进程、集成绑定）属应用侧，不进角色包；
- **manifest 不含凭证**：通道 app 只放标识，凭证存消费方平台侧；
- 人员解析不进包（人员-身份绑定是平台/组织资产，走 identity-registry）；
- 加载优先级：站点 `data/roles/` > 本目录（同 id 站点赢——定制权在站点维护者）。

## 域的数据面对照（同一分工在三个域的落位）

| 域 | 引擎（代码，packages/） | 定义（数据） |
|---|---|---|
| D4 编排 | layer-orchestration | `<site>/data/workflows/*.yaml` |
| D5 人格 | layer-persona | 本目录（模板）+ `<site>/data/roles/`（站点事实源） |
| 应用 | examples/<app> | `<site>/data/task-loop.json` 等 |
