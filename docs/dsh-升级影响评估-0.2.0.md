# dsh 套件升级影响评估：0.1.5-rc.2 → 0.2.0-rc.2

> 日期：2026-09-30 ｜ 应决策项 D6「先探明升级内容与兼容影响」的调研交付
> 方法：npm registry 逐版本依赖比对 + dsh-base 行清单（cordis.patch.yml）tarball 逐行 diff + `!!js` 表达式形态比对 + 本仓装载面核对
>
> **✅ 演练已执行（2026-09-30，沙箱分支 `dsh-0.2.0-upgrade` → 已合入 main，commit 4bd5303）**：
> 五关全绿——① dsh-interop 46/46（cordisAligned 单实例实证、profile 组合器 12 回归）② kernel-dsh 38/38 ③ peer 清零（cordis 4.0.2/4.0.4 分裂已用「5 个直接声明方统一 ~4.0.4」消除）④ dsh-host 四行种子在 0.2.0 上热装载成功 + ctx.tools 13 个工具 ⑤ 平台启动/feishu-dsh 重启冒烟通过。
> 过程修正：对齐测试随升（版本字符串 + hmr 行 0.2.0 改 profileContext 条件禁用）；system-prompt/tools 显式钉入 dsh-interop 随套件同升。已知留缝：`!!js "!ctx.get(...)"` 新形态组合器暂不支持（显式拒绝，安全失败），需要组 web profile 时再扩白名单。

---

## 一、结论

**0.2.0-rc.2 是低风险增量升级，"接缝全部失效"的担忧可以排除**：

| 接缝 | 0.1.5-rc.2 | 0.2.0-rc.2 | 影响 |
|---|---|---|---|
| **cordis 运行时** | `^4.0.2` | `~4.0.4` | **同为 4.x，补丁级推移**——无双运行时/大版本分裂风险；`cordisAligned` 校验在 bump 时实证（预判通过） |
| **dsh-base 行清单** | 84 行 | 94 行 | **存量 84 行全部保留，0 改名 0 删除**；新增 11 行（plugin-manager/tool-plugin-manager/mcp-resources/authorization/config-editor/ptc-runtime/workflow-ptc/deepseek-account/llm-deepseek-account/image-offload/otel）纯增量；仅移除 `workflow-worker-thread`（本仓未使用） |
| **`!!js` 表达式** | 9 种形态 | 9 种形态 | 唯一差异是遥测 collector URL 常量（且我们的 profile 默认硬关闭遥测）——**白名单求值器无感** |
| **平台挂载的包**（system-prompt / tools / mcp-client / tool-web） | 0.1.5-rc.2 系 | `next` tag 均有 0.2.0-rc.2 | 需**同升至 0.2.0-rc.2** 并过装载测试；见 §二注意项 |
| **套件自洽** | dsh-* 用 `^` 浮动 | dsh-* 全部精确 `0.2.0-rc.2` | 0.2.0 更严格，整包同升即可 |

新增行里的 `plugin-manager` / `tool-plugin-manager` 正是社区市场用的 `dsh plugin add` 官方链路——升级后才可用，与第三方插件准入直接相关。

## 二、注意项（升级演练的核对清单）

1. **dsh-system-prompt / dsh-tools 同升**：两包 `next` tag 有 0.2.0-rc.2，但其（旧版元数据里的）peer 声明是 `^0.0.1-rc.1` 系——升级时钉到 0.2.0-rc.2 并以**实际装载测试**为准（pnpm peer 警告不阻断，但要以 dsh-host 四行种子装载成功 + ctx.tools 可用为验收）；
2. **cordisAligned 实证**：bump 后跑 `dshSuiteVersions()`（`interop.ts:82`）确认 `cordisAligned === true`（预判：`^4.0.2` 与 `~4.0.4` 在 pnpm 下解析到同一 4.0.4+ 物理模块）；
3. **profile 组合器回归**：27 测试覆盖 insert/覆盖语义与 `!!js` 白名单，行清单新增项是数据不是语义，预期全绿；
4. **dsh-host 四行种子装载**：system-prompt / tools / mcp-demo（server-everything）/ web-tool 全部热装载成功 + dsh-tool 桥 list/call 可用；
5. **本仓挂载面零改动确认**：平台/示例不直接 import 任何 dsh 内部 API（dsh-interop 唯一落脚点），升级面收敛在 dsh-interop 的版本钉与锁文件。

## 三、建议执行方案（待拍板）

1. **沙箱分支演练**（半天）：`dsh-interop` 的 dsh / dsh-base bump `0.2.0-rc.2`、cordis 放行 `~4.0.4` → pnpm install → 依次跑 cordisAligned 校验、kernel-dsh 冒烟、profile 组合器测试、dsh-host 四行种子装载、aigility-platform 启动冒烟；
2. 全绿 → 合入 dev，README 版本记录 breaking/变更点（生态文档 §六 演练流程）；
3. 合入后 → 放开**第三方 DSH 插件准入**（插件中心可装社区包）+ 官方 `dsh plugin` 链路可用；
4. **回退**：版本全精确钉，回退 = revert 两处 package.json + lockfile，无数据迁移；
5. baojing Phase 1 **不被此阻塞**（Neo4j MCP 是独立进程，rc.2 即可装）——升级与拼装可并行。

## 四、证据

- npm registry：`@deepseek-ai/dsh@0.1.5-rc.2` dependencies（cordis `^4.0.2`，dsh-* `^0.1.5-rc.2` 浮动）vs `@deepseek-ai/dsh@0.2.0-rc.2`（cordis `~4.0.4`，dsh-* 精确 `0.2.0-rc.2`；新增 dsh-plugin-manager / dsh-mcp-resources / dsh-workflow-ptc 等包）；dist-tags `latest=next=0.2.0-rc.2`
- `dsh-base` 0.1.5-rc.2 vs 0.2.0-rc.2 的 `cordis.patch.yml` 逐行 diff（本机 tarball 实拉）：84→94 行，存量全保留
- `@deepseek-ai/dsh-system-prompt` / `@deepseek-ai/dsh-tools`：`next=0.2.0-rc.2` 存在，peer 含 cordis `^4.0.1-rc.1`（4.x 兼容）
- 本仓锁点：`packages/dsh-interop/package.json`（dsh / dsh-base 精确 0.1.5-rc.2，cordis ^4.0.2）+ `cordisAligned` 保险丝（`interop.ts:82-94`）
