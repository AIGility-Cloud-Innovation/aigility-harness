# @ingress/feishu 设计文档

> harness L1 底座层：飞书机器人通用入口（gateway）
> 与 `wecom-ingress` 同构的「传输入口」——WS 长连接收消息 → 按 App ID 路由到对应角色人格
>
> 状态：**设计稿，待确认**（未落码）
> 作者：Johnny / Hermes Agent | 日期：2026-09-02

---

## 1. 目标与定位

让**多个飞书机器人角色**共用一个成熟的飞书接入实现（ingress / gateway）：

```
飞书机器人 A（AppID₁+Secret₁）┐
飞书机器人 B（AppID₂+Secret₂）├→ @ingress/feishu（通用连接层）→ 配置识别 → 角色人格 X/Y/Z
飞书机器人 C（AppID₃+Secret₃）┘            （AppID → persona 映射）
```

- **ingress 只做协议活**：WS 长连接、心跳/重连、收消息、回消息——与具体人格无关
- **「连到哪个人格」由配置决定**：每个 App ID 绑定一个 persona，ingress 收到消息按来源 App ID 路由
- 与 http-ingress 的 `DEFAULT_AGENT_ROUTES`（路径→人格）同构，只是识别键从 URL 路径变成飞书 App ID

### 为什么是 ingress 而非直接在人格里接

1. **复用**：企微、HTTP、飞书都是同一套「接入→路由→角色→回复」范式，飞书只是多一个实现
2. **多机器人扩展**：加一个新飞书机器人 = 加一个配置条目，不用改代码
3. **agentd 的飞书逻辑是私有实现**（Go 内嵌），搬进 harness 后与其它通道统一，可观测、可替换

---

## 2. 依赖

- **SDK**: `@larksuiteoapi/node-sdk`（官方）`^1.73.1`
  - 支持 WS 长连接（`wss://` 长连接模式，免公网回调）
  - `im.message.receive_v1` 事件订阅
  - 发送消息 API（P2P / 群聊）
- **运行时**: Node 20+，与 harness 其它 L1 插件一致

---

## 3. 接口设计（对齐 wecom-ingress 范式）

### 请求

```ts
export interface FeishuIngressRequest {
  /** 飞书 App ID；缺省读 FEISHU_APP_ID 环境变量 */
  appId?: string;
  /** 飞书 App Secret；缺省读 FEISHU_APP_SECRET 环境变量 */
  appSecret?: string;
  /**
   * 消息 → 角色映射。识别键 = 来源 App ID（支持多机器人多角色共用）。
   * 默认 { "*": "@persona/timem-support" } —— 全部走 timem-support 人格。
   */
  agentRoutes?: Record<string, string>;
  /** 兜底角色（未命中 agentRoutes 时） */
  perceptionId?: string;
  /** 流式占位文案（"正在处理…"） */
  thinkingText?: string;
}
```

### 响应

```ts
export interface FeishuIngressResponse {
  ok: boolean;
  connected: boolean;
  appId: string;
  /** 断开连接函数 */
  stop: () => Promise<void>;
}
```

### 服务/清单

```ts
export const feishuIngressService: ServiceDefinition<FeishuIngressRequest, FeishuIngressResponse> = {
  id: "@infrastructure/feishu-ingress",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description: "飞书机器人入口（WebSocket 长连接 → 角色路由）",
};

export const manifest: PluginManifest = {
  name: "@infrastructure/feishu",
  layer: LayerId.Infrastructure,
  description: "底座层：飞书入口（机器人 WebSocket 长连接 → 角色路由）",
  version: "1.0.0",
  provides: [feishuIngressService],
  consumes: [/* timem-support 等角色引用，装配时决定 */],
  preferredCarrier: CarrierKind.Thread,
};
```

---

## 4. 消息处理流程

```
WS 收到 im.message.receive_v1
  → 解析：text / sender / chat_id（P2P 或群聊）
  → 空文本直接忽略
  → roleId = agentRoutes[appId] ?? agentRoutes["*"] ?? perceptionId
  → 调角色人格：ctx.call({ id: roleId }, { user_input, user_id })
  → 回复（支持 Markdown）
```

与 wecom-ingress 完全同构，仅 `client` 换成 lark SDK。

---

## 5. 配置映射（首个实例）

| 配置键 | 值 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | `cli_a9e24e913a39dcd6` | 「项目小助手」机器人（已启用，activate_status=2） |
| `FEISHU_APP_SECRET` | 从 vault `feishu-app-secret` 读取 | 0600 文件库 |
| `agentRoutes` | `{ "*": "@persona/timem-support" }` | 全部走 timem-support 人格 |
| 角色引用 | `@persona/timem-support` | harness 已有该人格（真实接入 TiMEM） |

> 凭据来源：与 agentd 共用一个 vault（`~/.config/TiMEM Project/credentials/`，已核：`feishu-metadata` + `feishu-app-secret` 都在，0600）。

---

## 6. 与 timem-project 的关系（分工不变）

- **ingress 只接人格，人格后面再接 project 执行器**（关键价值留 project 的分工不动）
- timem-project 作为「执行器插件」挂在人格的 workflow 下游，本次**不涉及**
- agentd 现有飞书直连逻辑：新 ingress 就绪后**不再需要 agentd 自带飞书**（可选演进，本次不做）

---

## 7. 验收标准

1. `@ingress/feishu` 插件在 harness 内装配，连上飞书 WS 长连接（日志出 `connected`）
2. 飞书私聊/群聊发消息 → 消息进入 timem-support 人格 → 有回复（流式占位 + 最终回复）
3. 换一个 App ID 配置 → 路由到另一人格（多机器人角色验证）
4. 凭据缺失时优雅报错（不 panic）
5. 断线重连（SDK 内置指数退避）

---

## 8. 工作量与风险

| 项 | 评估 |
|---|---|
| 新插件代码量 | ~150-200 行 TS（含 manifest/provider），照 wecom-ingress 抄骨架 |
| SDK 依赖 | `@larksuiteoapi/node-sdk@^1.73.1`（pnpm add 到 layer-infrastructure） |
| 风险 | 飞书事件订阅需在开放平台配「长连接」模式（agentd 已验证过通）；P2P 消息需 `im:message` 权限（已开） |
| 测试 | 单测（路由映射）+ 真实冒烟（连 App cli_a9e24e… 发消息） |

---

## 9. 待确认点

- [ ] 插件 ID：`@infrastructure/feishu-ingress` 还是 `@ingress/feishu`？（现有命名是 `@infrastructure/wecom`，建议跟随现有 = `@infrastructure/feishu`）
- [ ] 角色引用：默认路由 timem-support，还是装配时由外部决定？
- [ ] 多机器人映射是否现在就做（agentRoutes 按 AppID 路由），还是先单机器人最小版？
