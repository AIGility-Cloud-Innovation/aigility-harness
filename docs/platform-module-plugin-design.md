# 智悦工作台底座 · 模块插件化与功能装配设计（含 FDE 工作台接入计划）

> 版本：v0.1 ｜ 日期：2026-09-28 ｜ 状态：草案待审
>
> 定位：回答「智悦智能平台（aigility-platform）作为工作台底座，功能板块如何插件化装配；FDE 工作台如何不再独立维护前端，而是『底座 + 应用包 + 预设』的派生形态」。
>
> 关联：[plugin-integration-design](plugin-integration-design.md)（引擎侧插件，本文管产品板块层，二者不重叠）｜ [AI治理路线图](AI治理路线图.md)（G1 授权 / G4 可换）｜ [app-permission-design](app-permission-design.md)（角色权限规格）｜ [aigility-platform README §与 fde-workbench 的关系](../examples/aigility-platform/README.md)

---

## 1. 一句话与目标

**一套底座（智悦 SPA），模块注册表决定装配形态；「FDE 工作台」= 底座默认模块集 + FDE 应用包的命名预设，不是一份 fork 出来的代码。**

目标：

1. 智悦现有「模块装配」页从 Mock 变真：模块清单可版本化、开关状态持久化、变更留审计，成为正式的**功能管理页**；
2. FDE 工作台以「应用包」形态插入智悦导航，按预设一键装配/卸下；
3. 终态收敛为**单一前端代码库**，FDE 工作台的 18 个 sections 收编为底座内的应用包子树，按需逐个提升为一等模块。

非目标（本期明确不做，防过度设计）：

- 不引入微前端框架（qiankun / module federation）与运行时动态下载上架；
- 不做第三方开发者插件市场（引擎侧插件机制见 plugin-integration-design，与本文分层）；
- 不实现 License/订阅计费（「订阅模块」类目维持演示，引擎无对应服务）；
- 不动五域引擎插件装载机制（dsh-interop / LayerPlugin 照旧）。

## 2. 现状盘点（代码证据）

| 资产 | 位置 | 现状 |
|---|---|---|
| 模块装配页 | `examples/aigility-platform/app/src/pages/ModulePage.tsx` | UI 完整：分类卡片 + 开关 + 「保存为项目模板」（Mock 提示条）+ 按项目覆盖（演示态） |
| 模块注册表 | `app/src/mock/data.ts:551` `moduleRegistry`（`ModuleDef` 15 项） | **写死在 mock**；`core`（不可关）/`available`（可订阅未上线）已建模，`deps` 仅文案 |
| 装配状态 | `app/src/App.tsx:64` `enabledModules` | **内存 `useState`**，刷新即丢；导航显隐 + 路由守卫（`App.tsx:131`）已按开关生效 |
| 引擎侧插件范式 | `dsh_plugins` PG 表、dsh-interop 装载、能力总线（ToolsPage 枚举 46 Provider） | 已跑通；ToolsPage「插件开关」为 Mock（README 已标注） |
| FDE 工作台前端 | `examples/fde-workbench/app`（React + Vite + Tailwind + shadcn，与智悦同栈） | 独立站点（:1234），sections：Leads/Proposals/Contracts/Delivery/Deployments/Channels/Audit/Knowledge/Ontology/Mcp/Modules/Tasks/Performance… |
| FDE 数据与账号 | AppBase `users` 共库即共账号；台账持久化 `/app/data` JSONB（owner=`app:fde-workbench`，19 分片） | 已 AppBase 化，**token 全线互通是现成基础** |
| FDE 引擎链路 | `@persona/fde-assistant`（:1235 网关） | 智悦市场页「FDE 交付助手」已互通 |

**缺口**：① 装配状态无持久化、注册表混在 mock；② 「插件」概念目前只在引擎侧，产品板块层没有 manifest；③ 两个前端零代码共享（各自 Login/store），跨站跳转需二次会话传递。

## 3. 核心设计决策

### D1：一套底座 + 预设派生，不做 fork

「FDE 工作台大致基于智悦增删而来」必须由**同一代码库 + 模块配置**实现。两套前端互相拷贝 = 双倍维护 + 必然漂移，是本方案要消灭的最大反模式。验收标准：仓库里不存在「为 FDE 复制出来的第二份智悦前端」。

### D2：模块 = 三层捆绑，用 manifest 描述

一个「功能板块」插件至少捆三样东西，缺一层就不是可插拔模块：

```
前端板块（导航项 + 页面/子应用）
  ├── 服务端能力（它调用的封装 API 前缀）
  └── 数据归属（AppBase PG owner / 表）
```

manifest 只描述与装配有关的事实，业务实现照旧——**声明与实现分离**，与「执行器路由 YAML 只声明数据面，节点函数体留代码」同一边界哲学。

### D3：装配开关先行，动态挂载留缝不实现

- **第一级（本期）**：全部模块随应用静态构建，注册表决定「装不装」——导航显隐 + 路由守卫 + 开关持久化。今天只有两个消费方且都是自家 monorepo 包，动态加载是过度设计。
- **第二级（留缝）**：页面按模块 id 惰性加载（`lazy()`），manifest 的 `entry.mode` 预留 `redirect / iframe / inline` 三态。将来若要独立部署/第三方上架，沿 manifest 升级即可，不需要重写装配层。

### D4：FDE 接入粒度 = 应用包优先，不拆 18 个 sections

fde-workbench 的 sections 是**强关联的一个业务领域**（Leads→Proposals→Contracts→Delivery 共用一套台账数据模型）。一上来拆平 = 每块都要独立的数据归属与 API，成本爆炸且破坏领域完整性。路径：整体作为「应用包」类目下的第一个模块插入，之后只把**业务上确实需要独立开关/复用**的板块（候选：Knowledge、Audit）逐个提升为一等模块。

### D5：装配状态的「声明在代码，状态在库」

- **模块清单（manifest）**：TS 类型化注册表，随代码评审（不 YAML 化——它和图标/路由强耦合，TS 能给类型检查；与 executor-dispatch.yaml 的 YAML 化场景不同，后者是纯数据面路由）。
- **装配状态（开/关、预设、按项目覆盖）**：AppBase PG 表，随运营操作变更。对齐 `dsh_plugins` 先例与治理支柱「可审」：每次开关写 `audit_log`。

## 4. 模块清单（ModuleManifest）与注册表

### 4.1 类型定义

```typescript
// app/src/modules/types.ts（新增，从 mock/data.ts 的 ModuleDef 演进）
export type ModuleKind = 'page' | 'app-package'
export type ModuleCategory = '平台层' | 'TiMEM 上下文层' | '平台能力' | '订阅模块' | '应用包'
export type EntryMode = 'redirect' | 'iframe' | 'inline'   // S1 / S2 / S3 对应三态

export interface ModuleManifest {
  id: string                    // 'fde-ledger'
  name: string
  kind: ModuleKind
  category: ModuleCategory
  desc: string
  core?: boolean                // 核心模块不可关闭（沿 ModuleDef.core）
  available: boolean            // false = 可订阅未上线
  deps?: string[]               // 依赖的模块 id：开启需依赖已开，关闭依赖方时提示连带隐藏
  // —— kind = 'page'：SPA 内路由板块（现有 15 个模块全部此类）——
  page?: string                 // 路由 key，沿 ModuleDef.page
  // —— kind = 'app-package'：FDE 工作台等垂直应用 ——
  entry?: {
    mode: EntryMode
    url?: string                // redirect/iframe 目标（S1: http://127.0.0.1:1234）
    routePrefix?: string        // inline 时 SPA 子树（S3: '/fde'）
  }
  serverRoutes?: string[]       // 依赖的封装 API 前缀（审计/权限归集用，如 ['/api/fde-chat']）
  enginePlugins?: string[]      // 依赖的引擎能力（如 ['@persona/fde-assistant']，仅标注，不驱动装载）
  dataOwner?: string            // 数据归属（如 'appbase:/app/data owner=app:fde-workbench'）
  badge?: string
}
```

### 4.2 注册表落位

- 新建 `app/src/modules/registry.ts`：现有 `moduleRegistry` 15 项迁入（mock/data.ts 只留演示数据），补充「应用包」类目；
- App.tsx 导航与守卫逻辑**零改动**（已按 registry + enabled 集合驱动）。

### 4.3 装配状态持久化（AppBase PG，platform.ts 建表）

```sql
CREATE TABLE IF NOT EXISTS app_modules (
  scope      TEXT NOT NULL DEFAULT 'platform',  -- 'platform' 全局；租户/项目 id 留给 P2
  module_id  TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, module_id)
);

CREATE TABLE IF NOT EXISTS app_module_presets (
  id          TEXT PRIMARY KEY,                 -- 'fde-workbench' / 'default'
  name        TEXT NOT NULL,
  enabled_ids JSONB NOT NULL,                   -- 模块 id 数组
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

合并规则：代码注册表 ∪ DB 覆盖（`scope='platform'`），DB 无行时取 manifest 默认值。`core=true` 的行忽略开关（服务端拒写）。

## 5. 功能管理页（ModulePage 真化）

### 5.1 封装 API（挂 `:1236/api/aigility/*`，AppBase 会话校验，与既有封装 API 同风格）

| 接口 | 说明 |
|---|---|
| `GET /api/aigility/modules` | 返回 `{ modules: ModuleManifest[], state: Record<id,boolean>, presets }`（注册表 ∪ DB 合并结果） |
| `PUT /api/aigility/modules/:id` | `{ enabled }`；校验 core/available → 写库 → `audit_log`（actor=登录邮箱，action=`module.toggle`） |
| `GET /api/aigility/modules/presets` | 预设列表 |
| `POST /api/aigility/modules/presets` | `{ name, enabled_ids }` 保存当前装配为模板（真化「保存为项目模板」按钮） |
| `POST /api/aigility/modules/presets/:id/apply` | 套用预设 = 批量 PUT |

### 5.2 页面行为

- 开关即时生效：沿用现有导航显隐 + `moduleDisabled` 守卫兜底页（App.tsx 已具备），新增开关走 API 持久化；
- 关闭带 `deps` 依赖方的模块时，前端提示连带隐藏清单（第一期提示不强制，依赖图不做拓扑校验）；
- 「按项目覆盖配置」选择条本期维持演示态（P2 接 tenants）；
- 与 ToolsPage 的关系：ToolsPage 管引擎侧工具/插件（能力总线、MCP），ModulePage 管**产品板块装配**——两个页面、一个心智：「功能管理」。后续可在 ToolsPage 插件开关真化时共用同一张 `app_modules` 式状态表模式（本期不做）。

## 6. FDE 工作台接入：四步走

| 步骤 | 形态 | 改动面 | 验收 |
|---|---|---|---|
| **S1 挂接** | 应用包 `entry.mode='redirect'`，智悦导航新增「FDE 台账」（订阅模块类目下首个应用包），点击带会话跳转 :1234 | 智悦：registry 加一项 + 导航渲染应用包入口；fde 侧：校验 AppBase token（已共库共账号，预计零改动，若 token 载体不同则补一条校验） | FDE 预设开启后从智悦一键进入工作台，无二次登录；关闭后导航与直达均不可见 |
| **S2 同源** | 智悦 server（:1236）反代 `/fde/*` → :1234 静态资源、`/fde/api/*` → :1235；`entry.mode='iframe'` 同源内嵌 | 仅智悦 `src/index.ts` 加反代；两站代码零改动 | 无跨端口跳转，内嵌无二次登录；token 走同源 cookie，消解 S1 的跨站会话传递 |
| **S3 收编** | fde-workbench app 构建并入智悦 SPA：`/fde` 子树惰性路由（`entry.mode='inline'`），`entry.mode='inline'` 沿 manifest 无感切换；store/data 保留；fde 服务端并入智悦装配或保留独立进程（反代继续兼容） | 大件，独立排期（同栈收编，风险在同名组件如 TwinGraph3D——以目录命名空间隔离） | 单一前端站点；「FDE 工作台」= 预设切换产物；fde-workbench 独立前端退役 |
| **S4 拆细（触发式）** | 候选板块（Knowledge/Audit/Channels）提升为一等 `kind='page'` 模块 | 每拆一个：manifest 一项 + 数据 owner 划清 + serverRoutes 归集 | 仅当出现「该板块需独立于 FDE 应用包被复用/开关/计费」的真实需求时触发 |

S1→S3 每步只改 `entry.mode` 一个字段，装配层与导航零重写——这是 D3「留缝」的直接回报。

## 7. 预设模板（WorkbenchPreset）

```
default        = 智悦默认模块集（现有 15 项全开，core 除外不可关）
fde-workbench  = default − 平台壳演示板块（数据接入/知识图谱/市场等按 FDE 实际取舍）+ fde-ledger 应用包
```

- 种子随启动播种进 `app_module_presets`（对齐 `app_modules`/`dsh_plugins` 播种惯例）；
- 登录后按用户/租户绑定预设（P0 先全局单套状态，P2 接预设与项目覆盖）；
- ModulePage「保存为项目模板」即写此表——mock 里已经写好的文案，真化即可。

## 8. 实施计划

### Phase 0：装配底座（模块注册表真化 + 持久化 + 功能管理页变真，约 1 天）
- [ ] `app/src/modules/types.ts` + `registry.ts`：ModuleManifest 类型与 15 项迁入，新增「应用包」类目
- [ ] `src/platform.ts`：建 `app_modules` / `app_module_presets` 表（幂等，对齐现有建表惯例）
- [ ] `src/index.ts`：GET/PUT modules + presets 三组封装 API（会话校验 + audit_log）
- [ ] App.tsx：登录后拉取装配状态替换内存 useState；开关调 PUT
- [ ] ModulePage：接真 API；「保存为项目模板」真化
- [ ] 验收：关闭「知识图谱」→ 刷新后导航仍无 + 直达路由被守卫拦 + audit_log 有记录

### Phase 1：FDE 应用包挂接（约 0.5 天）
- [ ] registry 增 `fde-ledger`（kind='app-package', mode='redirect', url=:1234, serverRoutes/enginePlugins/dataOwner 按 §4.1 填全）
- [ ] 智悦导航渲染应用包入口（区分于普通 page 模块的图标/徽标）
- [ ] fde 侧验证 AppBase token 互通，缺口则补校验
- [ ] 验收：S1 验收标准（§6 表）

### Phase 2：同源反代 + 预设模板（约 1 天）
- [ ] 智悦 server 反代 `/fde/*`（静态 + API），entry 切 `iframe`
- [ ] 种子 `default` / `fde-workbench` 两个预设；apply API 生效
- [ ] 评估按项目覆盖接 tenants（可顺延）
- [ ] 验收：S2 验收标准；切换预设导航即时变化

### Phase 3：前端收编（大件，独立排期，估 3–5 天）
- [ ] fde app 并入智悦 SPA（/fde 子树 lazy route + 目录命名空间），entry 切 `inline`
- [ ] fde 服务端并入智悦装配或保留独立进程 + 反代（择一，开工前定）
- [ ] fde-workbench 前端退役，README 更新为「预设 + 收编说明」
- [ ] 验收：S3 验收标准

### Phase 4：按需拆细（不排期，触发式）
- [ ] 触发条件见 §6 S4；每拆一个走同一清单：manifest + 数据 owner + serverRoutes + 审计

## 9. 风险与开放问题

| 风险/问题 | 缓解 | 决策 |
|---|---|---|
| FDE sections 领域强耦合，拆细成本高 | D4：应用包优先，S4 触发式 | ✅ 已定 |
| 两套前端长期并存、体验割裂 | S2 同源内嵌先行缓解，P3 收编终解 | 收编排期独立评审 |
| `enabledModules` 全局单套 vs 按用户/租户 | P0 全局，P2 接预设/项目覆盖 | 分期 |
| core 模块误关导致平台不可用 | core 服务端拒写 + 守卫兜底页（已有） | ✅ 已定 |
| 订阅模块 `available:false` 无计费/License 服务 | 维持演示态，引擎 License 立项后再真化 | ✅ 已定 |
| 两站同名组件（TwinGraph3D 等）收编冲突 | S3 以目录命名空间隔离，不做组件级合并 | 开工前复核 |
| 模块开关是否联动引擎侧 persona/插件启停（如关市场是否下线路由） | 第一期只管导航与守卫，不动引擎装载 | ✅ 本期定 |
| fde 网关 :1235 与智悦网关 :1237 合并时机 | S3 收编时一并评估 | 开放 |
| 预设与角色权限关系（谁可改装配） | 对齐 app-permission-design 的 r-admin（集成商管理员）语义 | 开放 |
| 跨站会话传递（S1 阶段跨端口） | S1 仅本地回环端口可接受；S2 同源后消解 | ✅ 已定 |

## 10. 与治理路线图的对齐

- **G1 授权**：装配 API 全部过 AppBase 会话校验，core/available 服务端校验，变更主体入 audit_log；
- **可审 Audit**：`module.toggle` / `preset.apply` 事件入 `audit_log`，与登录/操作留痕同表；
- **可换 Replaceable**：manifest 的 `entry.mode` 三态 + 惰性加载留缝，装配契约不变的前提下板块实现可整体替换——「契约是主体，插件是过客」在产品板块层的同构表达。
