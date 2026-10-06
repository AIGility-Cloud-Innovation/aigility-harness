# roles/ — 公共角色包目录（harness 项目所有）

> **所有权**：本目录属于 aigility-harness 项目（机制层）。公共角色的事实源在这里，git 版本化。
> 各网站（智悦/fde-workbench/…）是消费方：各自的私有角色放 `examples/<site>/roles/`（站点覆盖公共，同 id 站点优先）；编辑器（如智悦工厂）只是读写本目录的一个实现，不是事实源。

## 角色包格式（v1）

一个角色 = 一个目录，两份文件：

```
roles/<role-id>/
  SKILL.md    # 人设：frontmatter（name / description）+ 正文 = 角色 Prompt（DSH/agent-skills 惯例，原生可读）
  role.json   # 五要素声明：identity / sources / actions / outbound / memory（schema 见 @aigility-harness/role-kit）
```

约定：
- `role_id` = 目录名 = persona key = 记忆域（memory.agent_id 恒等于 role_id）；
- `sources.channels` 可选——不声明即纯网页/后台角色（通道绑定可选, 基线 1）；
- **manifest 不含凭证**：通道 app 只放标识，凭证存消费方平台侧；
- 人员解析不进包（人员-身份绑定是平台/组织资产，走 identity-registry）；
- 加载优先级：站点私有 > 本目录（同 id 站点赢——定制权在站点维护者）。
