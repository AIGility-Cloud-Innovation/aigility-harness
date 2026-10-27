/**
 * 把 P 组里台账已 done 的旧卡挪到 C 待测试。
 *
 * 根因（2026-10-27 查明）：
 *   系统里 done→C 的自动逻辑（task-issue-sync.ts:1932）只存在于
 *   「agent 任务」分支内（前置闸门 1899 行 `if (humanExecutor===undefined && agentDecided)`）。
 *   这 4 条是**人工卡**（无【agent】前缀），根本不进那个分支 →
 *   完成状态从不被回写飞书 → 永远留在 P。
 *   与「台账 failed 无法进 D」无关（那是另一回事）。
 *
 * 所以这批只能手动挪，符合「人工卡人工收尾」的既定分工。
 */
import { userToken } from "./feishu-user-token.mts";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const P = "ba9c4d86-dcdd-479d-8093-2bd21782f9a5";         // P 计划中
const C = "b5a841a3-054a-4db8-8b5c-fe014dbe1767";         // C 待测试

/** 要迁移的卡（台账 status=done 但仍在 P） */
const TARGETS = [
  { guid: "828e8533-1fe4-437b-948e-8dd8590fb201", label: "解析失败：万份简历中有3份简历…已锁定失败根因" },
  { guid: "73b259fd-9929-4c0f-a015-9636ee58800d", label: "重点产业人才供给：按学校自定义配置" },
  { guid: "76f739e4-9c3c-48f9-bf47-3626dd1a1862", label: "演示账号：调整为有权限才能进管理后台" },
  { guid: "3ac36bf7-3bfc-4293-860d-db0766059cdf", label: "为各销售公司创建/下发演示系统管理账号" },
];

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

  for (const { guid, label } of TARGETS) {
    // 先确认当前确实在 P
    const pNow: any = await api("GET", `/open-apis/task/v2/sections/${P}/tasks`, undefined, {
      page_size: "100", user_id_type: "open_id",
    });
    const inP = (pNow.data?.items ?? []).some((t: any) => t.guid === guid);
    if (!inP) {
      console.log(`⏭ ${label.slice(0, 34)} —— 不在 P 组，跳过`);
      continue;
    }

    // 从 P 移除
    const rm = await api("POST", `/open-apis/task/v2/tasks/${guid}/remove_tasklist`, {
      tasklist_guid: LIST, section_guid: P,
    }, { user_id_type: "open_id" });

    // 加进 C
    const mv = await api("POST", `/open-apis/task/v2/tasks/${guid}/add_tasklist`, {
      tasklist_guid: LIST, section_guid: C,
    }, { user_id_type: "open_id" });

    console.log(`${mv.code === 0 ? "✅" : "❌"} ${label.slice(0, 34)}  (移除:${rm.code} 移入:${mv.code}${mv.msg ? " " + mv.msg : ""})`);
  }

  // 复核
  const cNow: any = await api("GET", `/open-apis/task/v2/sections/${C}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const inC = new Set<string>((cNow.data?.items ?? []).map((t: any) => t.guid));
  const pAfter: any = await api("GET", `/open-apis/task/v2/sections/${P}/tasks`, undefined, {
    page_size: "100", user_id_type: "open_id",
  });
  const pCount = (pAfter.data?.items ?? []).length;
  console.log(`\n复核：C 组 ${inC.size} 条 | P 组剩 ${pCount} 条`);
  for (const { guid, label } of TARGETS) {
    console.log(`  ${inC.has(guid) ? "✅" : "❌"} 已在 C：${label.slice(0, 34)}`);
  }
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });