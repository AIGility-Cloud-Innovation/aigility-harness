# 应用权限与按应用授权设计（两权分离 + manager 角色）

> 状态：**两权分离（使用权/管理权）已实现**（`feat/appbase-process-host` 分支）；**按应用授权（manager 角色）设计定稿、未实施** —— 本文档为其实施规格。
> 关联：`app-management-design.md`（账号/Key/用量）、进程宿主（process-host，见 `feat/appbase-process-host` 提交 70a4325）。

## 1. 两权模型（已实现）

每个登录用户对每个应用处于两种关系之一，权限互不重叠：

| | 使用权 | 管理权 |
|---|---|---|
| 谁有 | `app_members` 成员 ∪ 应用 owner（平台管理员全可见） | 应用 owner ∪ 平台管理员 |
| 能做什么 | 大厅看到并打开应用；走 LLM 代理；读写应用数据 | 管理抽屉全部能力：成员 / 应用账号 / API Key / LLM 配置 / .env / **后端进程启停与日志** |
| 服务端闸门 | `visibleHallApps` + 各使用路由的成员校验 | `/app/hall/manage` 前缀块**单点判定**（backend.ts，owner ∪ `isAdminUser`），块内全部子路由自动继承 |

要点：

- **闸门是单点**。管理类路由全部收敛在 `if (path.startsWith("/app/hall/manage"))` 块内，
  管理权的增删改只动一处判定，不存在逐路由散落的检查。
- **进程管理属管理权**。进程宿主（process-host）的注册/启停/日志路由挂在 manage 块内，
  使用权用户不可触达。
- **平台管理员专属 ≠ 管理权**。卸载应用、版本历史（`index.ts` hallAppsHandler 内逐路由
  `isAdminUser`）、创建应用、平台设置（`/admin` 有服务端门禁）比管理权更高，owner 也不行 ——
  前端抽屉对非管理员的 owner 隐藏这两块。
- **入口一致性**（7811aab）：`GET /app/hall/apps` 按应用标注 `owner`，「设置」按钮渲染
  条件 = `isAdmin || owner`，与服务端闸门一致。

## 2. 缺口（本设计要解决的）

管理权目前是**两个固定身份**（owner / 平台管理员）的函数，无法按应用授予普通用户：

- `app_members` 是平的 —— 进去即使用权，没有任何管理语义；
- 场景：教师需要管理自己班级的应用（改 LLM 配置、管进程），但不应成为平台管理员；
  某应用易手运维时，只能改库或让平台管理员代劳。

## 3. 授权设计：manager 角色（待实施）

### 3.1 数据模型

```sql
ALTER TABLE app_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
```

- `'member'` 使用权（默认，存量行自动等价现状）；`'manager'` = 该应用管理权；
- owner 不在 `app_members` 里（在 `apps.owner_id`）；平台管理员不在任何授权表里；
- **有效管理权判定**：`owner ∪ is_admin ∪ (app_members.role = 'manager')`。

### 3.2 闸门改动（单点，~10 行）

`backend.ts` manage 块现有判定：

```ts
// 现在: owner ∪ admin
if (own.rows.length === 0 && !(await isAdminUser(userId))) return 403;
```

放宽为（其余全部子路由自动继承，无逐路由改动）：

```ts
// 之后: owner ∪ admin ∪ manager
const isManager = own.rows.length === 0 && (await pool.query(
  "SELECT 1 FROM app_members WHERE app_id=$1 AND user_id=$2 AND role='manager'",
  [appId, userId])).rowCount! > 0;
if (own.rows.length === 0 && !isManager && !(await isAdminUser(userId))) return 403;
```

注：owner 的自动注册逻辑（首次管理写 apps 表）保持不变 —— manager 首次进入不会抢占归属。

### 3.3 语义边界（manager 不能做什么）

| 操作 | manager | 说明 |
|---|---|---|
| 抽屉内日常管理（成员增删 / 账号 / Key / LLM 配置 / .env / 进程启停日志） | ✅ | 管理权的组成部分 |
| 移除普通成员 | ✅ | 日常管理 |
| **授权/收回他人 manager、移除其他 manager** | ❌ | 仅 owner ∪ 平台管理员；防权限自我扩散 |
| 卸载应用、版本历史 | ❌ | index.ts 逐路由 `isAdminUser`，不动 |
| 创建应用、平台设置（/admin）、跨应用任何操作 | ❌ | 平台级，与授权无关 |

### 3.4 接口改动

| 接口 | 改动 |
|---|---|
| `POST /app/hall/manage/member` | body 可带 `role`；`role='manager'` 仅 owner ∪ 平台管理员可设，否则 403 |
| `PUT /app/hall/manage/member/:uid/role` | 新增：`{role: 'manager'|'member'}`，owner ∪ 平台管理员专属 |
| `GET /app/hall/manage` | 响应加 `myPower: 'owner'\|'admin'\|'manager'`；members 行带 `role` |
| `GET /app/hall/apps` | 每应用加 `manager` 布标（与 `owner` 标注同款查询，查 `app_members.role`） |

授权/收回写审计：`writeAudit(email, 'app.member.role', appId, 目标邮箱+角色)`。

### 3.5 前端改动（app-hall.html，~40 行）

- 「设置」按钮渲染：`isAdmin || a.owner || a.manager`；
- 成员列表行加角色徽标（`管理` okchip / `成员` offchip）；
- `myPower` 为 owner/admin 时，成员行出现「设为管理 / 取消管理」（两击确认）；
- manager 打开抽屉时隐藏 owner 专属控件（成员授权按钮），其余照常。

### 3.6 兼容性

- 新列有默认值：不写 role 时全部现有行为不变；
- manager 被授权者天然满足可见性（`visibleHallApps` 走 `app_members`，manager 也是成员行），
  可见性零改动；
- 闸门单点 + 一条新小路由 + 列表/前端标注，**约半天工作量**。

## 4. 验收清单（实施时逐条过）

1. owner 将某成员设为 manager → 该成员重新加载大厅：可见该应用 + 「设置」入口；
2. manager 进抽屉：可改 LLM 配置、启停后端进程、看日志；成员列表只见「移出」；
3. manager 不可见版本历史/卸载；直接调对应接口得 403；
4. manager 调授权接口（PUT role）得 403；
5. owner 收回 manager → 对方刷新后入口消失，manage 接口 403；
6. 普通成员 / 平台管理员行为与现状完全一致（回归）；
7. 审计日志出现 `app.member.role` 记录。

## 5. 决策记录

- 2026-09-26：两权分离确认成立；入口不一致已修（7811aab）；
- 2026-09-26：manager 角色设计定稿暂缓实施 —— 触发条件：平台出现"第二个人需要管理
  非本人创建的应用"的真实需求时启动，半天内可落地。
