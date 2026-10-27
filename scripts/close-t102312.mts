/**
 * 处理 t102312（障碍分析员误判生成的修复单）→ 挪「挂起」+ 台账归档。
 *
 * 为什么关（2026-10-27 用户拍板）：
 *   该单由障碍分析员对 t102308 失败自动生成，核心结论「权限范围（置信度 high）」
 *   是**误判** —— 真实根因是 pr-finisher 基线探测缺陷（merge-base 引用不存在的
 *   远程 agent/* 分支）。它给出的"解决/预防建议"（检查 origin 配置、git fetch --all、
 *   手动创建引用、检查网络可达…）全部指向错误方向，属无效工作。
 *   根因已由代码修复（提交 1a6bbb1 已在 main）并经真实操作验证（merge-base origin/main 成功）。
 *   上游 t102308 已由用户决定降低验收标准收工 → 本单前提消失。
 *
 * 处理：飞书卡挪「挂起」组（保留痕迹、不再出现在 P 噪音中）
 *       台账 record 归档（archive，非 delete，保留可回溯）
 */
import { userToken } from "./feishu-user-token.mts";
import { readFileSync, writeFileSync } from "node:fs";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const P = "ba9c4d86-dcdd-479d-8093-2bd21782f9a5";
const HOLD = "d77c81d1-fa50-478b-a436-258fb56bcb1a";
const GUID = "ec1cf96d-af6d-4ef2-9168-45935eaf6190";
const UID = "tsk_d23333e3-304a-4f88-ac69-a7dd5c87b4a3";
const REG = "/home/johnny/AI/aigility-harness/config/task-registry.local.json";

const REASON = `【已关闭 · 2026-10-27】本单判定有误，非有效的修复任务。

原判定：障碍类别「权限范围」（置信度 high）——**误判**。
真实根因：pr-finisher 基线探测缺陷 —— detectBaseBranch 在 origin/HEAD 缺失时
  回退当前本地分支 agent/*，导致 merge-base 引用不存在的远程分支 → exit 128。
  （与权限、网络、origin 配置均无关。）

根因已由代码修复（提交 1a6bbb1，已在 main）：
  · detectBaseBranch 改为优先 origin/main → master → dev，忽略本地 agent/* 分支
  · 已补回归测试；真实工作区实测 merge-base origin/main 成功
  · 附带：obstacle-analyst 新增「工具链缺陷」类 + 注入诊断证据；composeFailureNote 防证据被截断

本单的"解决/预防建议"（检查 origin 配置、git fetch --all、手动创建引用、检查网络可达…）
均指向错误方向，属无效工作，不执行。

关闭原因：根因已修 + 上游 t102308 已由用户决定降低验收标准收工 → 本单前提消失。
`;

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

  // ① 描述追加关闭原因
  const one = await api("GET", `/open-apis/task/v2/tasks/${GUID}`, undefined, { user_id_type: "open_id" });
  const oldDesc: string = one.data?.task?.description ?? "";
  if (oldDesc.includes("【已关闭 · 2026-10-27】")) {
    console.log("⏭ 描述已含关闭说明，跳过");
  } else {
    const newDesc = REASON + "\n" + "─".repeat(30) + "\n原单内容（保留存档）：\n" + oldDesc;
    if (newDesc.length > 3000) {
      console.log(`⚠️ 合并后 ${newDesc.length} 字超限 → 只写关闭说明 + 原内容前 1200 字`);
      const upd = await api("PATCH", `/open-apis/task/v2/tasks/${GUID}`, {
        task: { description: REASON + "\n─".repeat(30) + "\n原单内容（节选）：\n" + oldDesc.slice(0, 1200) },
        update_fields: ["description"],
      }, { user_id_type: "open_id" });
      console.log(`  ${upd.code === 0 ? "✅" : "❌"} 描述更新: ${upd.code}`);
    } else {
      const upd = await api("PATCH", `/open-apis/task/v2/tasks/${GUID}`, {
        task: { description: newDesc },
        update_fields: ["description"],
      }, { user_id_type: "open_id" });
      console.log(`  ${upd.code === 0 ? "✅" : "❌"} 描述更新(${newDesc.length}字): ${upd.code}`);
    }
  }

  // ② 从 P 移除 → 挪挂起
  const rm = await api("POST", `/open-apis/task/v2/tasks/${GUID}/remove_tasklist`, {
    tasklist_guid: LIST, section_guid: P,
  }, { user_id_type: "open_id" });
  console.log(`从 P 移除: ${rm.code === 0 ? "✅" : "跳过 " + rm.msg}`);

  const mv = await api("POST", `/open-apis/task/v2/tasks/${GUID}/add_tasklist`, {
    tasklist_guid: LIST, section_guid: HOLD,
  }, { user_id_type: "open_id" });
  console.log(`挪「挂起」: ${mv.code === 0 ? "✅" : "❌ " + mv.msg}`);

  // ③ 台账归档（保留记录，status=archived）
  const reg = JSON.parse(readFileSync(REG, "utf-8"));
  const tasks = reg.tasks ?? reg;
  const rec = tasks.find((t: any) => t.uid === UID);
  if (!rec) {
    console.log("⚠️ 台账未找到该 record");
  } else if (rec.status === "archived") {
    console.log("⏭ 台账已 archived");
  } else {
    rec.status = "archived";
    rec.note = "[关闭] 障碍分析员误判「权限范围」；真实根因=pr-finisher 基线缺陷，已修(1a6bbb1)并经实测验证。上游 t102308 已收工 → 本单前提消失。";
    rec.updatedAt = Date.now();
    writeFileSync(REG, JSON.stringify(reg, null, 2) + "\n");
    console.log(`✅ 台账归档: ${rec.status} (uid=${UID})`);
  }

  // ④ 复核
  const chk = await api("GET", `/open-apis/task/v2/sections/${HOLD}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const inHold = (chk.data?.items ?? []).some((t: any) => t.guid === GUID);
  const pNow = await api("GET", `/open-apis/task/v2/sections/${P}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const stillP = (pNow.data?.items ?? []).some((t: any) => t.guid === GUID);
  console.log(`\n复核：t102312 在「挂起」= ${inHold ? "✅" : "❌"} | 仍在 P = ${stillP ? "❌ 是" : "✅ 否"}`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });