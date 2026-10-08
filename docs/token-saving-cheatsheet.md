# DSH 省 Token 秘籍

> 来源：本机实际安装的包 + 本会话实际生效的 bundle 层，逐行核对。
> 安装根：`/home/johnny/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`（196 个包，v0.1.0-rc.6）
> 本会话 profile：`DSH_PROFILE=headless` → bundle 层 = `dsh-base` + `dsh-headless`，再由
> `examples/.dsh-home/profiles/headless/cordis.patch.yml` 覆盖，再叠加角色 `--patch`。
>
> **本文修正了此前对话里两处错误说法**（见文末「修正记录」）：spill 的单位是**字节不是 token**；
> 本安装里**没有** `image-offload` 插件。

---

## 0. 一句话总览

省 token 不是靠「少说话」，而是靠**四道闸门**把进入模型上下文的东西逐级截断，外加**两道复用**避免重复付费：

```
工具输出 → ① 工具自带 acquire 上限 → ② spill（字节级落盘） → ③ pruner（字符级修剪）
        → ④ compaction（整段对话压缩）
                                    复用：⑤ KV Cache（前缀命中）  ⑥ 子上下文分流
```

关键区别：**①②③ 是「截断」，④ 是「销毁」，⑤⑥ 是「不重复发」**。截断保真（落盘可回读），销毁不可逆。

---

## 1. 四道闸门

### ① 工具自带上限（最上游，最先省钱）

在结果**进入**策略层之前，各工具自己就设了 acquire 上限。这些是**工具级**的，与 spill 策略无关。

| 工具 | 配置键 | 生效值 | 行为 |
|---|---|---|---|
| `bash` | `bash-sandbox.timeoutMs` | 60000 | 超时截断，链接完整 spill 文件 |
| `glob` | `globMaxResults` | 100 | 超出的路径进 spill 产物 |
| `grep` | `grepMaxMatches` | **250** | 超出进 spill；对齐 Claude Code `head_limit` |
| `grep` | `grepMaxLineBytes` | 2000 | 单行预览字节上限，保 UTF-8 边界，标 `(line truncated)` |
| `grep`/`glob` | `rawOutputMaxBytes` | 20000000 | raw rg 输出上限，超了直接 `SEARCH_RAW_OUTPUT_OVERFLOW` 报错 |
| `grep`/`glob` | `stderrMaxBytes` | 65536 | 只留 stderr 尾部 |
| `str_replace_editor` | `maxOutputChars` | 16000 | 编辑结果字符上限 |
| agent 指令 | `agent-instructions.maxBytes` | 65536 | 系统指令文本上限 |

**要点：`grep` 只留 250 条，不是全部。** 这是本会话里最常触发的闸门。
`fs-search` 的 `sampleOverCapGlobResults: false`（本 install 显式设的）→ 超 cap 的 `glob` 保留**修改时间序头部**，不采样。

### ② spill：字节级落盘（`dsh-spill-policy` + `dsh-spill-local`）

**这是最省的一层，也是我此前说错的一层。**

```yaml
# dsh-base cordis.patch.yml 实际值
- id: spill-policy
  config:
    maxInlineBytes: 50000      # ← 单位是 UTF-8 字节，不是 token！
```

| 项 | 事实 |
|---|---|
| 单位 | **UTF-8 字节**（`maxInlineBytes`），schema 只校验「非负整数」 |
| 默认 | 省略 = **完全禁用**（插件注册 nothing，真 no-op） |
| 本会话值 | 50000 字节 |
| 超限行为 | 全文存盘 → 模型只看到 head/tail 预览 + `(Omitted N bytes. Full formatted result stored at: <path>. …)` |
| 预算保障 | 预览按预算收缩，**替换结果永不超 cap**；notice 装不下就保留原文 |
| 落盘位置 | 会话级私有目录，`open(path,'wx',0o600)`，防符号链接劫持 |
| 失败降级 | best-effort：存盘失败 → 保留原 inline 结果，**不把成功调用变成 error** |

**绕过 spill 的白名单**（理解这些才知道什么省不下来）：
- `read` 的结果**永不 spill**（避免 `read → spill → 再 read` 死循环）
- 嵌套执行（`exec.parent` 存在）→ 其 durable 副本由 dispatch-log 分支处理
- 已被下游 hook 替换过的值（需重新校验渲染）
- 任一非 `accept` 决策（`block` 的纠正反馈原样通过）
- 含**任意非文本块**的结果（图片等）
- 纯文本且 ≤ cap → 原样放行

> `read` 豁免这条最重要：**用 `read` 读大文件时，spill 不会救你**，必须自己带 `offset/limit`。

### ③ pruner：字符级修剪（`dsh-compaction-tool-result-pruner`）

```yaml
- id: tool-result-pruner
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
```

| 项 | 事实 |
|---|---|
| 触发时机 | **仅在 compaction 已经够格之后**，且**压力之下不 prune** |
| 单位 | Unicode **码点**（code point），非字节非 token |
| 行为 | 替换为 head + `\n\n[... tool result middle pruned ...]\n\n` + tail |
| 幂等 | 二次 pass 不再产生替换（结果严格小于输入） |
| 保真 | 原事件仍在持久化日志里，可回读 |
| 约束 | `headChars + marker + tailChars` 必须 < `thresholdChars` |

**② 与 ③ 的关系**：② 在**产生时**按字节截断（模型根本看不到全文）；③ 在**压缩时**按码点修剪**已经躺在上下文里的**结果。前者省得早，后者是补救。

### ④ compaction：整段压缩（`dsh-compaction-basic`）

```yaml
- id: compaction-basic      # 无 config → 全用默认值
```

| 键 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | **0.8** | 在 `floor(contextWindow × 0.8)` 触发 |
| `retainRatio` | **0.16** | 最近 16% 上下文窗口逐字保留 |
| `maxTokens` | 8192 | 摘要调用生成上限 |
| `compactionRetries` | 1 | 首次之后的重试次数 |
| `maxOverflowRetries` | 1 | 溢出后重试上限 |
| `auto` | true | 注册 step 边界压力监听 |

**实测代码逻辑**（`resolveCompactSpec`）：

```js
thresholdTokens = Math.floor(contextWindow * thresholdRatio)   // 0.8
retainTokens    = Math.floor(contextWindow * retainRatio)      // 0.16
```

**注意：不存在 `W−O−65536` 这种公式**——那是我此前的错误记忆。真实机制是：
比例阈值（0.8）× **该路由适配器自报**的 context window；模型发现（`listModels`）只是 advisory，**不参与**决策。
校验规则：`retainRatio` 必须 **<** `thresholdRatio`，否则插件加载失败。

**省钱设计亮点 —— 摘要调用吃 KV cache：**
摘要不是「另起一个请求把对话发一遍」，而是**逐字节重放** system prompt + tools + 被遮蔽区域的消息，成为原对话的**真前缀**，最后追加一条压缩指令当 user message。
→ 结果：**只有尾部指令 + 摘要输出是未缓存的**，前面全部命中 warm prefix。
另外 `purpose: 'compaction'`，DeepSeek 适配器发 `x-deepseek-harness-compact: 1` 做归因，**不改模型可见 body**。

**收敛保障**：摘要不缩小源 → 拒绝；重试仍回不到阈值以下 → 抛错。

---

## 2. 两道复用

### ⑤ KV Cache（前缀复用）

原理：请求前缀字节一致 → 命中 provider 缓存，只付增量。

**保持缓存命中的三条纪律：**

1. **追加而非改写**。所有截断机制都设计成 append-only：spill 替换、pruner 替换、工具结果追加——新内容都在可复用前缀**之后**，不使已有 KV 缓存失效。
2. **`subagent_fork` 不选模型**。fork 子 agent 继承父对话的**已完成轮次**（在最后一个 `turn/end` 处切），字节一致 → 子 agent 首个请求可复用父的前缀。
   - ⚠️ 但本 install 里 fork 工具是 **`backgroundMode: one-shot`**，**不是** continuable。原因：continuable 子 agent 会额外带 `report` 工具 + 其 prompt section，这些 delta **排在继承历史之前** → 会**使全部继承前缀失效**。所以「continuable 的 fork 省不了缓存」是设计结论，不是配置疏漏。
   - fork 的数量权衡：子 agent 收到的是**已完成历史的副本**，会独立累积 token。**fork 不是免费的**——它省的是**主线上下文**，代价是**总量重复**。首轮 fork 无继承历史，等于纯 spawn。
3. **计划模式的工具目录不变**。plan mode 明确写着「tool catalog 保持一致以维持 request-cache 稳定性」——不要为了让计划模式"干净"而动态摘工具。

### ⑥ 子上下文分流

把**探索**甩进子 agent，只把**结论**带回主线：

- `subagent` / `subagent_fork`：子 agent 在自己的上下文里干活，父 agent 只收**最终结果**（`dsh-tool-subagent` 只传子 agent 的 final output，不传中间的继承前缀和工作过程）。
- `workflow`：大规模 fan-out（审计多文件、迁移、多角度研究）用脚本编排，每个子 agent 是独立上下文。

**代价**：父 agent 的 input 增长一个「数据相关的最终结果」，保留到下次 compaction。**任务小的时候用子 agent 反而更贵**（多一次完整 system prompt + tools 的下发）。

---

## 3. 计量层（`dsh-token-meter`）

不是省 token 的，是**让省 token 的机制知道该不该动手**。

| 项 | 事实 |
|---|---|
| 估算启发式 | **固定 4 字符 ≈ 1 token** + 角色/块/信封结构开销 |
| 配置 | **无**，任何键都被拒绝 |
| 模型容量 | 归属适配器（`ctx.llm.resolveModelInfo().context`），token-meter 不管 |
| 精确性 | 有 provider usage 时复用真实值（需请求信封匹配）；否则全量启发式估算 |
| 输出 | `contextPressure` 投影出 `pressureTokens` / `projectedTokens` / `contextWindow` |

**含义：阈值（0.8 / 0.16 / 8192）都是在这个 4:1 启发式上算的**，中文场景字符/token 比更高，实际触发点会偏保守。

---

## 4. 其他生效的小阀门

| 机制 | 插件 | 值 | 作用 |
|---|---|---|---|
| 重复工具提醒 | `repeat-tool-reminder` | 阈值 `[3,5,8]`，参数预览 500 字符 | 连续重复调用时提醒 → 抑制无意义探索 |
| 会话标题 | `session-title-llm` | targetWords 5 / targetCjkCharacters 10 / maxInputBytes **4096** / maxOutputTokens **64** | 标题生成是一次**完整 aux LLM 调用**，这里把它锁死 |
| 技能徽章 | `skill-badge` | `disabled: true` | 关掉一个注入项 |
| 手动压缩 | `/compact` | — | 主动降到阈值以下一次有效缩减 |
| 会话搜索 | `session-query-sqlite` | `openAt: never` | **不省 token，省资源**：SQLite 从不开，全文搜索报 `SESSION_QUERY_SEARCH_DISABLED` |

---

## 5. 我的纪律（不靠插件，靠行为）

这部分是**我调用工具时的习惯**，直接决定上面四道闸门会不会被触发：

1. **`grep`/`glob` 替代 `cat` 全仓** — 让 ① 的 250 条上限替我截断。
2. **`read` 必带 `offset`/`limit`** — 因为 `read` 是 spill 白名单，没有第二道防线。
3. **给 `grep` 管 `head -N`** — 在 ripgrep 层面就断开，连 250 条都不占满。
4. **并行发独立工具调用** — 多个只读探查一次往返，省的是**轮次**（每轮都要重发 system prompt）。
5. **先探边界再深读** — `ls` / `package.json` / `README` 目录，定位到真正的配置文件再读全文。
6. **不重复探索** — 已经确认过的事实不再查第二遍（`repeat-tool-reminder` 是我的兜底，不是首选）。
7. **大输出直接落盘再用 `grep` 搜** — 而不是把它整个读进上下文。

---

## 6. 可调旋钮（你来定取舍，我不擅自改）

按**性价比**排序：

| 旋钮 | 现值 | 调低的效果 | 风险 |
|---|---|---|---|
| `spill-policy.maxInlineBytes` | 50000 B | 降到 20000 → 长输出更早落盘 | 预览更短，可能需要多一次 `read` |
| `tool-result-pruner.thresholdChars` | 8192 | 降到 4096 → 压缩时省更多 | 中段丢失更多（可回读原日志） |
| `tool-result-pruner.headChars` | 4096 | 与 tail 一起调，总预算更紧 | 同上 |
| `compaction-basic.thresholdRatio` | 0.8 | 降到 0.7 → 更早压缩 | 压缩调用更频繁（但吃缓存） |
| `compaction-basic.retainRatio` | 0.16 | 降到 0.10 → 保留更少逐字 | 近期细节丢失 |
| `session-query-sqlite.openAt` | `never` | 改 `first-search` → 可搜历史 | 多一个 SQLite 写入面 |
| `grepMaxMatches` | 250 | 降到 100 | 需要更多次窄查询 |

**判断依据**：如果你的日志/输出普遍很长、且很少需要完整回看 → **往下调**。
如果你经常需要完整输出做精确编辑 → **保持或上调**。

---

## 7. 明确没生效 / 不存在的

诚实清单，避免你把它们算进「已省」：

| 项 | 状态 |
|---|---|
| `image-offload` | **本安装里不存在**。我查遍 196 个包 + 所有 `cordis.patch.yml`，无此插件、无 `imageOffload` 符号。（此前对话里我把它列为生效机制，错误。） |
| `web_search` | **坏的**：`Error: DeepSeek search has no API key for "DEEPSEEK_API_KEY"`。web 工具显式 `fetch: false`（防 SSRF，因为模型会自己选目标）。 |
| `session-telemetry-otel` | 默认 `DISABLED`（`DSH_TELEMETRY_MODE` 未设）。 |
| `session-query-sqlite` | `openAt: never` → SQLite 不打开。 |
| 手动 `/compact` | 我**没有主动用过**；本次任务规模不值得。 |
| 子 agent 委派 | 本次**没有用**；任务小，委派反而多付一次 system prompt + tools。 |

---

## 8. 一页速查

```yaml
# 本会话实际生效的省 token 参数（全部来自 dsh-base cordis.patch.yml，headless 层未覆盖）
bash timeoutMs:            60000
globMaxResults:            100
grepMaxMatches:            250
grepMaxLineBytes:          2000
str_replace_editor chars:  16000
agent-instructions bytes:  65536
spill maxInlineBytes:      50000      # 字节！不是 token
pruner thresholdChars:     8192       # 码点
pruner head/tail:          4096/1024
compaction thresholdRatio: 0.8        # × 适配器自报 contextWindow
compaction retainRatio:    0.16
compaction maxTokens:      8192
repeat-reminder thresholds: [3,5,8]
session-title maxOutput:   64
```

**三条最值钱的纪律**（超过任何插件配置）：
1. 用 `grep`/`glob` 而不是 `cat`。
2. `read` 永远带 `offset`/`limit`（它不享受 spill 豁免）。
3. 并行只读探查，减少轮次。

---

## 修正记录（相对此前对话）

| 此前说法 | 实际 | 证据 |
|---|---|---|
| 「`dsh-spill-policy` 超 **12500 tokens**」 | **50000 UTF-8 字节**，且单位根本不是 token | 包内 `Config = z.object({ maxInlineBytes })`；`dsh-base` 设 `maxInlineBytes: 50000` |
| 「自动压缩触发 `min(W×0.8, W−O−65536)`」 | 只有 `floor(contextWindow × 0.8)` | `resolveCompactSpec()` 源码 |
| 「`image-offload` 超图片预算用占位符替换」 | **该插件不存在于本安装** | 196 包全列表 + 全量 grep 无 `imageOffload` |
| 「`session-query-sqlite` 是其省 token 机制」 | 是**资源**优化，非 token 优化 | README：`openAt: never` → SQLite 从不打开 |
| 「pruner 阈值 8192 字符」 | 正确，但单位是 **Unicode 码点** | 源码 `DEFAULTS` + README |

**方法说明**：以上全部来自**本机已安装的包源码与 README**，不是网上查的、也不是凭记忆写的。
`web_search` 在本 profile 因缺 `DEEPSEEK_API_KEY` 不可用，所以本轮**没有外部资料**——
如果你要外部对比资料（比如 Claude Code / Cursor 的省 token 策略），需要先配好该 key。