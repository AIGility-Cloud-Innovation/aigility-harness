/**
 * 把 t102308 派发到 D 组（工人小组接手）。
 *
 * 前置：
 *   1. 标题已符合派发条件（【agent】+ [org/repo] 前缀）——已核对；
 *   2. 分支 agent/t102044-t102128-cce8fe 已推送远端（失败根因之一已消除）；
 *   3. 描述需追加「续用 cec9aae」指令，防工人把它当"派发前已有"而误判无新改动。
 *
 * 步骤：更新描述 → 挪 D 组 → 复核。
 */
import { userToken } from "./feishu-user-token.mts";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const TASK = "01f56a97-033d-457f-8f3d-73a7ff953a00";
const SEC_A = "e4da3910-5b59-4f63-a7a2-296bc5dd11b4"; // A 待修复（当前所在）
const SEC_D = "D 执行中";

const RESUME_NOTICE = [
  "",
  "════════════════════════════════════════",
  "【⚠️ 重跑须知 —— 必读，2026-10-27 追加】",
  "",
  "本卡此前失败不是任务本身的问题，而是交付链基线对齐缺陷（已修复）。",
  "工作区已有有效产出，**必须续用，禁止丢弃重跑**：",
  "",
  "  工作区：/home/johnny/AI/.worktrees/aigility-harness-cce8fe",
  "  分支　：agent/t102044-t102128-cce8fe（已推送 Gitea 远端）",
  "  已有提交：cec9aae",
  "  文件　：packages/layer-orchestration/src/task-issue-sync.ts（+10/-2）",
  "  内容　：决策幂等（防重复提交）、决策写入失败回滚、格式非法提示——",
  "　　　　　正是本卡要求的「回复解析续跑」核心接线。",
  "",
  "⚠️ 注意：该提交在本轮派发前已存在，系统快照会把它记为「派发前已有」。",
  "　 因此本轮**必须产生新的改动**（补单测、typecheck、补完剩余接线），",
  "　 否则会再次被判「工作区无新改动」而失败。",
  "",
  "本轮要做：",
  "  1. 续用 cec9aae，补齐状态机与意图解析单测；",
  "  2. typecheck 0 错误；",
  "  3. 推送分支 + 创建 Gitea PR（保持开启不合并），PR 链接写进汇报；",
  "  4. 验收：对现挂 needs-input 任务真实回复一次「决策」指令，观察台账转 ready 并续跑。",
  "",
  "边界：不改 worker-team 派发/续跑内核；不实现超时转 failed。",
  "风险：原卡 t102044/t102128 两次均因 codex 30 分钟超时失败，本卡范围更大 →",
  "　　　建议拆阶段，先跑通最小闭环。",
  "════════════════════════════════════════",
].join("\n");

async function main() {
  const T = await userToken();
  const api = async (method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const url = new URL(`https://open.feishu.cn${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return (await r.json()) as { code?: number; msg?: string; data?: any };
  };

  // ① 读当前描述
  const one = await api("GET", `/open-apis/task/v2/tasks/${TASK}`, undefined, { user_id_type: "open_id" });
  const cur = one.data?.task;
  if (!cur) throw new Error(`读任务失败: ${one.code} ${one.msg}`);
  const oldDesc: string = cur.description ?? "";
  console.log("✓ 当前标题:", cur.summary);
  console.log("  当前描述长度:", oldDesc.length);

  // ② 追加续用须知（幂等：已含则跳过）
  let newDesc = oldDesc;
  if (oldDesc.includes("【⚠️ 重跑须知")) {
    console.log("  ⏭ 描述已含重跑须知，跳过更新");
  } else {
    newDesc = oldDesc.replace(/\n+❌ 最近失败[\s\S]*$/, "") + RESUME_NOTICE;
    const upd = await api("PATCH", `/open-apis/task/v2/tasks/${TASK}`, {
      task: { description: newDesc },
      update_fields: ["description"],
    }, { user_id_type: "open_id" });
    console.log(`  ${upd.code === 0 ? "✅" : "❌"} 描述更新: ${upd.code} ${upd.msg ?? ""} (${oldDesc.length} → ${newDesc.length} 字)`);
  }

  // ③ 找 D 组 guid
  const secs = await api("GET", "/open-apis/task/v2/sections", undefined, {
    resource_type: "tasklist", resource_id: LIST, page_size: "50", user_id_type: "open_id",
  });
  const dGuid = (secs.data?.items ?? []).find((s: any) => (s.name ?? "").trim() === SEC_D)?.guid;
  if (!dGuid) throw new Error(`未找到「${SEC_D}」分组`);
  console.log(`✓ D 组 guid=${dGuid}`);

  // ④ 从 A 组移除（若在）
  const rm = await api("POST", `/open-apis/task/v2/tasks/${TASK}/remove_tasklist`, {
    tasklist_guid: LIST, section_guid: SEC_A,
  }, { user_id_type: "open_id" });
  console.log(`  从 A 组移除: ${rm.code === 0 ? "✅" : `跳过(${rm.msg ?? rm.code})`}`);

  // ⑤ 挪进 D 组
  const mv = await api("POST", `/open-apis/task/v2/tasks/${TASK}/add_tasklist`, {
    tasklist_guid: LIST, section_guid: dGuid,
  }, { user_id_type: "open_id" });
  console.log(`${mv.code === 0 ? "✅" : "❌"} 挪 D 组: ${mv.code} ${mv.msg ?? ""}`);

  // ⑥ 复核
  const chk = await api("GET", `/open-apis/task/v2/sections/${dGuid}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const inD = (chk.data?.items ?? []).some((t: any) => t.guid === TASK);
  console.log(`\n复核：t102308 在「${SEC_D}」组内 = ${inD ? "✅ 是" : "❌ 否"}`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });