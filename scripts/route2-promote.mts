/**
 * 路线 2（2026-10-27 用户拍板）：手动把验证任务的台账 candidate → planned。
 *
 * 背景：
 *   该卡在 P 组扫描时被 adopt({status:"candidate"}) 建成 candidate；
 *   而 P 组派发循环（task-issue-sync.ts:1931）只处理 planned，其余一律 continue，
 *   candidate → planned 的推进链路（注释所述「确认 R编号」）实际未接完 → 死锁。
 *   用户选择绕过：直接改台账状态，让本卡能进 D 正常派发。
 *   （缺陷本身另议，不在本次改动范围。）
 *
 * 做法：
 *   1. 台账 candidate → planned（用 transition，走合法状态机）
 *   2. 卡片回 P 组（D 组路径要求台账已 planned 才会 approve 成功；
 *      且人工挪 D 即授权派发，符合现有设计）
 *   3. 等下一扫描拍 → planned 命中 P 循环 → 放行 → 挪 D → 工人认领
 */
import { userToken } from "./feishu-user-token.mts";
import { TaskRegistry } from "../packages/layer-orchestration/dist/task-registry.js";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const P = "ba9c4d86-dcdd-479d-8093-2bd21782f9a5";
const D = "de1b7c2e-c015-4c18-822b-fedc119a049d";
const GUID = "a560ab62-6263-4b7c-b9a2-1d3239ab9c8b";
const UID = "tsk_57ca0620-ab13-4a8b-94d0-eaf5253765d2";
const REG = "/home/johnny/AI/aigility-harness/config/task-registry.local.json";

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

  // ① 台账 candidate → planned
  const reg = new TaskRegistry(REG);
  reg.recover?.();
  const before = reg.get(UID);
  console.log(`台账当前: ${before?.status}`);
  if (before?.status === "planned") {
    console.log("⏭ 已是 planned，跳过");
  } else {
    const r = reg.transition(UID, "planned", "candidate");
    console.log(r.ok ? `✅ 台账推进: candidate → planned` : `❌ 推进失败: ${r.error}`);
    if (!r.ok) process.exit(1);
    reg.flushSync();
  }
  const after = reg.get(UID);
  console.log(`台账复核: ${after?.status}`);

  // ② 卡片回 P 组（从 D 移除 → 加进 P）
  const rm = await api("POST", `/open-apis/task/v2/tasks/${GUID}/remove_tasklist`, {
    tasklist_guid: LIST, section_guid: D,
  }, { user_id_type: "open_id" });
  console.log(`从 D 移除: ${rm.code === 0 ? "✅" : "跳过 " + rm.msg}`);

  const mv = await api("POST", `/open-apis/task/v2/tasks/${GUID}/add_tasklist`, {
    tasklist_guid: LIST, section_guid: P,
  }, { user_id_type: "open_id" });
  console.log(`回 P 组: ${mv.code === 0 ? "✅" : "❌ " + mv.msg}`);

  // ③ 复核
  const chk = await api("GET", `/open-apis/task/v2/sections/${P}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const inP = (chk.data?.items ?? []).some((t: any) => t.guid === GUID);
  console.log(`\n复核：卡在 P 组 = ${inP ? "✅" : "❌"}｜台账 = ${reg.get(UID)?.status}`);
  console.log(`\n下一步：等下一扫描拍（≤10min）→ planned 命中 P 循环 → 放行 → 挪 D → 工人认领`);
  console.log(`注意：TASK_AUTO_DISPATCH=0 时 P 循环只放行台账、不自动挪 D，需再手动挪 D 才派发。`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });