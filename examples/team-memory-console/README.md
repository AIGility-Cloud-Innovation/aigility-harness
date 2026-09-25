# team-memory-console — 团队成员 ↔ 太忆云 user_id 对齐

监控/管理团队成员与 Agent 助手交流产生的记忆时, 太忆云上的记忆按 `user_id` 隔离,
但云端并不知道 "user_id 101 是张三"。本工具补上这层对齐:

```
成员姓名/别名 ──登记表──▶ timem_user_id 列表 ──dsh-plugin-timem──▶ 太忆云记忆
记忆条目      ──登记表──◀ 反向标注归属人 (未登记 id 会被标记 ⚠)
```

## 组成

| 文件 | 职责 |
|---|---|
| `config/timem-team-registry.json` | 花名册 (single source of truth): 成员、别名、绑定的 user_id |
| `src/registry.ts` | 登记: 正向解析 (姓名/别名→成员)、反查 (user_id→成员)、bind/unbind 防串号 |
| `src/service.ts` | 查询: 成员→云端记忆 (多账号合并、按相关度排序、归属标注); probe 探测; cordis 插件封装 (`ctx.teamMemory`) |
| `src/cli.ts` | 命令行入口 |

## CLI

```bash
pnpm install   # 首次
pnpm --filter team-memory-console cli list                    # 花名册
pnpm --filter team-memory-console cli who 张三                 # 查对齐关系
pnpm --filter team-memory-console cli add li-si 李四 四哥      # 新增成员
TIMEM_API_KEY=sk-xxx pnpm --filter team-memory-console cli probe 101        # 探测云端该 id 是否有记忆
TIMEM_API_KEY=sk-xxx pnpm --filter team-memory-console cli bind li-si 101   # 绑定 (绑定前自动 probe)
TIMEM_API_KEY=sk-xxx pnpm --filter team-memory-console cli query 张三 部署 遇到什么问题
TIMEM_API_KEY=sk-xxx pnpm --filter team-memory-console cli query all 本周 计划
```

`query` 输出每条记忆的归属人; 结果中出现未登记的 user_id 会以 `⚠未登记(id)` 提示,
核对后用 `bind` 补录 —— 这就是发现新 user_id 的机制。

## 防串号约束

- 一个 user_id 全局只能绑定一个成员; 改绑需先 `unbind`, `bind` 到已被占用 id 会直接报错。
- `bind` 前自动 `probe`, 展示该 id 云端记忆样本, 供人工确认身份后再落库。

## DSH Agent 集成

```ts
import { Context } from "@deepseek-ai/cordis";
import { teamMemoryPlugin } from "team-memory-console/src/service.js";

const root = new Context();
await root.plugin(teamMemoryPlugin, {
  apiKey: process.env.TIMEM_API_KEY!,
  registryPath: "config/timem-team-registry.json",
});
// 自然语言 "查张三关于部署的记忆" →
const r = await root.teamMemory.query("张三", "部署 问题");
```

登记表是普通 JSON, Agent 也可以在对话中直接读写它来完成
"把 user_id 105 登记为王五" 这类指令 (改完无需重启, Registry 每次构造时加载)。
