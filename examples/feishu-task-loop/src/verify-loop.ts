/**
 * 真机闭环验证 v2：agentd 活体全链路
 * create-from-message → confirm-prompt(delayMs) → run 提前执行 → poll 终态
 * 全部走 harness 侧 agentd-client.ts（验证的正是派发域消费的原语面）。
 */
import { loadEnv } from "./env.js";
import {
  createFromMessage,
  confirmPrompt,
  runTask,
  getTask,
  pollTaskUntilFinal,
  defaultSocketPath,
  type AgentdEndpoint,
} from "@aigility-harness/layer-orchestration";

async function main(): Promise<void> {
  loadEnv();
  const endpoint: AgentdEndpoint = {
    socketPath: defaultSocketPath(),
    token: process.env["TIMEM_AGENTD_TOKEN"] ?? "",
  };
  if (!endpoint.token) {
    console.error("缺 TIMEM_AGENTD_TOKEN");
    process.exit(1);
  }

  // ① create-from-message（projectId 显式给 aigility-harness，跳过项目归属闸门）
  console.log("① create-from-message…");
  const created = await createFromMessage(endpoint, {
    source: "probe",
    sourceMessageId: `verify-loop-${Date.now()}`,
    sourceConversationId: "oc_verify_dispatch",
    text: "在 aigility-harness 项目执行：echo verify-dispatch-loop",
    title: "闭环验证：echo verify-dispatch-loop",
    description: "闭环验证：echo verify-dispatch-loop（无副作用探针）",
    projectId: "aigility-harness",
    trigger: "manual",
  });
  const taskId = created.id ?? created.taskId;
  console.log("   taskId:", taskId, "status:", created.status ?? "(见下一步)");
  if (!taskId) throw new Error(`create 未返回任务 id: ${JSON.stringify(created)}`);

  // ② 查态：预期 pending_confirm
  let cur = await getTask(endpoint, taskId);
  console.log("② getTask →", cur.status);

  // ③ confirm-prompt 入队，delayMs=10min（模拟派发闸门：定时自动跑，但可提前）
  if (cur.status === "pending_confirm") {
    const q = await confirmPrompt(endpoint, taskId, { delayMs: 600_000 });
    console.log("③ confirm-prompt(delayMs=10min) →", q.status);
  }

  // ④ run 提前执行（queued 可直接 run；agentd run 异步受理，响应体 null 由 client 兜底）
  cur = await getTask(endpoint, taskId);
  if (cur.status === "queued") {
    const r = await runTask(endpoint, taskId);
    console.log("④ run(提前) →", r.status);
  } else {
    console.log("④ 状态非 queued（", cur.status, "），可能 scheduleLoop 已抢先跑");
  }

  // ⑤ 轮询到终态（echo 任务应秒级完成；容忍 confirm→run 窗口的瞬时 404）
  console.log("⑤ poll 终态…");
  let finalStatus: string | null = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      finalStatus = await pollTaskUntilFinal(endpoint, taskId);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  cur = await getTask(endpoint, taskId);
  console.log(
    `终态: ${finalStatus} | lastError: ${cur.lastError ?? "无"} | ` +
      `title: ${cur.title ?? "-"}`,
  );
  console.log(finalStatus === "completed" ? "✅ 全链路闭环通过" : "⚠️ 终态非 completed，见上");
}

main().catch((e) => {
  console.error("闭环验证失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
