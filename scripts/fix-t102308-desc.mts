/**
 * 补丁：描述更新失败（超 3000 字上限）。压缩后重写。
 * 保留最关键的「重跑须知」，精简历史段落。
 */
import { userToken } from "./feishu-user-token.mts";

const TASK = "01f56a97-033d-457f-8f3d-73a7ff953a00";

const NEW_DESC = `【合并卡】原 t102044（needs-input 状态机+决策播报）与 t102128（决策回复接线：「决策 任务号 选项」解析→写决策文件→resume 续跑）合并为本卡，一次跑通完整闭环。

=== 目标 ===
agent 遇决策可暂停等人，用户群内一条消息决策后同上下文续跑；needs-input 不算失败；全程台账/卡片状态可见。

=== 前作一：状态机+嘴 ===
①worker prompt 约定遇分叉/歧义写 .agent-decision.json（问题/选项/默认项）后停止；②worker-team 收尾识别该文件→台账转 needs-input（非 failed，不计 failover），卡片挪「A 待修复」；③群播报结构化决策请求；④意图解析新增「决策 <任务号> <选项>」，回复后台账 needs-input→ready 重入队、卡片挪回；⑤重新认领时 codex resume+结论同上下文继续（不重跑）；⑥超时兜底（24h 无回复按默认项或转 failed，可配）。

=== 前作二：耳朵（回复接线）===
现象：needs-input 的「嘴」已接线（Gitea PR #75），但「耳朵」缺失——agent-decision.ts 约定的「群回复『决策 <任务号> <选项>』」从未实现，全仓无消费者，用户回复石沉大海。
解析后：registry.get(uid) 校验 status=needs-input → resolveDecisionCwd（worktree 优先，worker-team.ts:45）定位决策文件 → writeDecision(选项全文, decidedBy=回复人, decidedFrom=消息原文) → registry.reenqueueNeedsInput(uid)（needs-input→ready）→ worker-team 下一拍自动认领并原线程+结论续跑（worker-team.ts:265-285 已支持，勿改）。回执发回来源会话。

=== 边界（重要）===
不改 worker-team 派发/续跑内核；不实现超时转 failed（DECISION_TIMEOUT_MS 24h 够用）；Gitea PR #75 与本任务同文件区可能冲突（examples/feishu-task-loop/src/index.ts），冲突时 rebase 解决。

=== 验收 ===
单测全绿 + 对现挂 needs-input 任务真实回复一次「决策」指令，观察台账转 ready、worker 续跑。

=== 交付要求 ===
开启的 Gitea PR 到 AIGility-Cloud-Innovation/aigility-harness（基于 main）。
执行者：agent

════════════════════════════════════════
【⚠️ 重跑须知 —— 必读，2026-10-27 追加】

本卡此前失败不是任务本身的问题，而是交付链基线对齐缺陷（已修复）。
工作区已有有效产出，必须续用，禁止丢弃重跑：

  工作区：/home/johnny/AI/.worktrees/aigility-harness-cce8fe
  分支　：agent/t102044-t102128-cce8fe（已推送 Gitea 远端）
  已有提交：cec9aae
  文件　：packages/layer-orchestration/src/task-issue-sync.ts（+10/-2）
  内容　：决策幂等（防重复提交）、决策写入失败回滚、格式非法提示——正是本卡要求的「回复解析续跑」核心接线。

⚠️ 该提交在本轮派发前已存在，系统快照会把它记为「派发前已有」。
　 因此本轮必须产生新的改动（补单测、补完剩余接线），否则会再次被判「工作区无新改动」而失败。

本轮要做：
  1. 续用 cec9aae，补齐状态机与意图解析单测；
  2. typecheck 0 错误；
  3. 推送分支 + 创建 Gitea PR（保持开启不合并），PR 链接写进汇报；
  4. 验收：对现挂 needs-input 任务真实回复一次「决策」指令，观察台账转 ready 并续跑。

风险：原卡 t102044/t102128 两次均因 codex 30 分钟超时失败，本卡范围更大 → 建议拆阶段，先跑通最小闭环。
════════════════════════════════════════`;

async function main() {
  const T = await userToken();
  const bytes = Buffer.byteLength(NEW_DESC, "utf-8");
  console.log(`新描述：${NEW_DESC.length} 字 / ${bytes} 字节`);
  if (NEW_DESC.length > 3000 || bytes > 10000) {
    console.log("❌ 仍超限，需再压缩");
    process.exit(1);
  }
  const r = await fetch(`https://open.feishu.cn/open-apis/task/v2/tasks/${TASK}?user_id_type=open_id`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
    body: JSON.stringify({ task: { description: NEW_DESC }, update_fields: ["description"] }),
  });
  const d: any = await r.json();
  console.log(`${d.code === 0 ? "✅" : "❌"} 更新: code=${d.code} msg=${d.msg ?? ""}`);

  // 复核
  const chk: any = await (await fetch(`https://open.feishu.cn/open-apis/task/v2/tasks/${TASK}?user_id_type=open_id`, { headers: { Authorization: `Bearer ${T}` } })).json();
  const desc: string = chk.data?.task?.description ?? "";
  console.log(`复核：长度=${desc.length} | 含重跑须知=${desc.includes("【⚠️ 重跑须知") ? "✅" : "❌"} | 含 cec9aae=${desc.includes("cec9aae") ? "✅" : "❌"}`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });