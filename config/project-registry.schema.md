# project-registry v2 — 项目登记表与 harness.yaml 声明规范

> 2026-10-06 定稿。背景：harness 将作为**多网站通用后台**私有化部署，
> 每个网站一个独立业务代码仓库。本文件定义两层协作契约：
> **① harness 侧聚合登记表**（config/project-registry.json，本文件 $schema 所指）
> 与 **② 业务仓库侧声明文件**（各业务仓库根部的 `harness.yaml`，v2 新增）。

---

## 一、定位与分工

```
harness 部署实例（每企业一套，编排中枢）
  ├── 聚合登记表 project-registry.json   ← 汇总所有网站的声明（机器可合并）
  ├── 任务台账 / 复核 / 对齐器 / agentd / 看板
  └── 按 yaml 声明路由任务：agentd 写代码 / 真人挂工单 / 业务 webhook
        ▲
        │ 启动扫描 + 30s 热重载（两种来源取并集）
        │
业务网站仓库（每网站一个 git 仓库）
  └── harness.yaml   ← 网站对 harness 的全部声明（跟随业务代码走版本）
```

职责边界：

- **harness 拥有**：任务台账（R 码）、复核流（五要素/approve）、对齐器、
  agentd 执行、飞书/Gitea 通道、看板——一切"任务管理"通用能力；
- **业务仓库只声明**：我是谁（identity）、任务怎么路由（routing）、
  harness 何时回调我（webhooks）。**不含任何 harness 代码**；
- agentd 执行时克隆业务仓库、从 dev 拉 feat/fix 分支（既有规则不变），
  PR 正文带飞书任务链接（既有规则不变）。

## 二、业务仓库侧：harness.yaml（v2 新增）

放在业务仓库根目录，随业务代码走版本。三段式：

```yaml
# harness.yaml — 本网站对 harness 的声明
version: 2

identity:
  project_id: my-website          # 稳定英文短横线 id（全局唯一）
  name: 我的网站
  aliases: [myweb, 官网]           # 自然语言归属解析用
  gitea_repos:                    # 本项目在 Gitea 的仓库 full_name
    - AIGility-Cloud-Innovation/my-website
  feishu_chat_ids:                # 本项目对应的飞书群（汇总/提醒投递依据）
    - oc_xxxxxxxxxxxxxxxxxxxxxxxx

routing:                          # 任务类别 → 执行方式（互斥路由的声明式版本）
  default: human                  # 未命中类别的兜底：human | agentd
  rules:                          # 按序首条命中生效
    - match: { labels: [bug, hotfix] }   # 工单/任务标签匹配
      executor: agentd                      # 派 agentd 写代码
      branch: fix                           # agentd 分支类型：feat | fix（从 dev 拉）
    - match: { keywords: [文案, banner] }   # 标题/描述关键词匹配
      executor: human                        # 挂 Gitea 工单指派真人
      assignee: xubincheng                   # 可选：默认指派人（Gitea 用户名）
    - match: { keywords: [索引, 缓存] }
      executor: webhook                      # 调业务自身脚本/接口
      webhook: rebuild-index                 # 对应 webhooks 段的 key

webhooks:                         # harness → 业务系统的回调（带 HMAC 签名）
  rebuild-index:
    url: https://my-website.example.com/internal/harness/rebuild
    secret_env: HARNESS_WEBHOOK_SECRET_MYWEB   # 密钥从 harness 部署环境读，不入仓库
    events: [task.dispatched, task.completed]  # 触发时机
```

### 字段约束

| 段 | 字段 | 必填 | 说明 |
|---|---|---|---|
| identity | project_id | ✓ | 全局唯一；与聚合登记表主键一致 |
| identity | name / aliases | ✓ /  | 显示名 / 归属解析别名 |
| identity | gitea_repos | ✓ | `org/repo` full_name 数组 |
| identity | feishu_chat_ids |  | 项目群（缺省则该网站线索私信负责人） |
| routing | default | ✓ | 未命中规则时的执行方式 |
| routing | rules[].match | ✓ | `labels` / `keywords` / `priority` 三种，可组合（AND） |
| routing | rules[].executor | ✓ | `human` \| `agentd` \| `webhook` |
| routing | rules[].assignee |  | human 时的默认指派人（Gitea 用户名） |
| routing | rules[].branch |  | agentd 时的分支类型，缺省 feat |
| webhooks | *.url / secret_env / events |  | 回调端点；密钥只存部署环境，不入 git |

### 互斥路由与既有规则的衔接

- 声明在**指派时刻**求值：任务台账里显式指派（「R0x 执行人 xx」/「R0x 执行人 agentd」）
  优先于 yaml 规则；yaml 只解决"未显式指派时怎么路由"；
- 既有互斥锁不变：真人→agentd 禁止，agentd→真人可改派（带交接说明）；
- `webhook` 执行器复用真人路径的工单留痕（回调结果评论到工单），但默认不指派真人。

## 三、harness 侧：聚合登记表 project-registry.json（v2）

仍是 single source of truth，但 v2 起**允许两种来源取并集**：

1. **手工条目**（既有形态，兼容 v1 全部字段）——不适合发 yaml 的小项目/外部项目；
2. **扫描条目**（v2 新增）——启动时与 30s 热重载时扫描各业务仓库根的
   `harness.yaml`，解析进聚合表；`source: "harness.yaml"` 标记来源。

```jsonc
{
  "version": 2,
  "updated_at": "…",
  "projects": [
    // 手工条目（v1 兼容，原样保留）
    { "project_id": "nx-telecom", "name": "…", "gitea_repos": ["…"], "feishu_chat_ids": ["…"], "log_sources": [] },
    // 扫描条目（v2：由 harness.yaml 生成，手工编辑会被下次扫描覆盖）
    {
      "project_id": "my-website",
      "source": "harness.yaml",
      "manifest_repo": "AIGility-Cloud-Innovation/my-website",
      "name": "我的网站", "aliases": ["myweb", "官网"],
      "gitea_repos": ["AIGility-Cloud-Innovation/my-website"],
      "feishu_chat_ids": ["oc_…"],
      "routing": { "default": "human", "rules": [ /* 同 yaml 语义 */ ] },
      "webhooks": { "rebuild-index": { "url": "…", "secret_env": "…", "events": ["task.dispatched"] } }
    }
  ]
}
```

### v2 新增字段（Project 级）

| 字段 | 说明 |
|---|---|
| `source` | `"manual"`（缺省，v1 兼容）\| `"harness.yaml"`（扫描生成，只读） |
| `manifest_repo` | source=harness.yaml 时：声明文件所在的业务仓库 |
| `routing` | 路由规则（语义同上文 yaml；手工条目也可填） |
| `webhooks` | 回调端点表（语义同上文 yaml） |

### 向后兼容

- `version: 1` 文件无需迁移即可被读取（source 缺省 manual，routing/webhooks 可选）；
- 既有消费方（project-registry.ts / project-briefing.ts / 播报分流）不感知新增字段；
- 播报分流的 org 判定（TiMEM-AI/ 前缀）后续可升级为按 routing 声明判定，暂不变更。

## 四、多网站部署形态（定稿）

- **一个企业一套 harness 实例**，编排 N 个业务网站（集中编排、业务仓库轻适配）；
- 新接入一个网站 = 在其业务仓库根部提交一份 `harness.yaml`（PR 评审），
  harness 扫描后自动登记——**业务团队不需要动 harness 仓库**；
- 私有化交付物（后续）：docker-compose（harness + PG + LiteLLM）+ 配置模板 +
  初始化向导，一份 compose 起一套完整中枢。

## 五、消费方与演进

- 现有消费方：`packages/layer-orchestration/src/project-registry.ts`（加载/解析/30s 重载）、
  `project-briefing.ts`（多源汇总）、`task-pipeline.ts`（播报分流）；
- v2 待实施（按依赖序）：
  1. project-registry.ts 支持 `source/manifest_repo/routing/webhooks` 字段透传；
  2. 扫描器：遍历聚合表 gitea_repos 对应仓库根的 harness.yaml → 生成扫描条目；
  3. routing 求值器：指派时刻按声明路由（rules 首条命中），与显式指派/互斥锁衔接；
  4. webhook 调度器：task.dispatched/completed 事件按声明回调（HMAC 签名）。

---

## 附：v1 字段（继续有效）

| 字段 | 必填 | 说明 |
|---|---|---|
| `project_id` | ✓ | 稳定英文短横线 id；**项目级 timem 记忆的虚拟用户键为 `project:<project_id>`** |
| `name` | ✓ | 显示名 |
| `aliases` |  | 自然语言查询别名（如「nx」「太忆」） |
| `gitea_repos` |  | `org/仓库` full_name 数组 |
| `gitea_orgs` |  | 整组织项目（briefing 时经 `/orgs/{org}/repos` 动态展开） |
| `feishu_chat_ids` |  | 项目群 chatId（`oc_` 开头） |
| `log_sources` |  | log-monitor 监控项 `{host, p, s}`（p=项目键，s=服务名） |

飞书任务清单不单独登记：沿用既有约定「一个 Gitea 组织 = 一个任务清单」（`tasklistNameForRepo`），
任务标题 `[org/repo#N]` 前缀可反查仓库归属。
