/** 飞书侧准备：①两任务描述改「执行者：agent」+PR 交付要求 ②建「⏸ 挂起」组挪入 3 个挂起任务 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";
const LIST_GUID = "d72fffc9-c62a-45f8-a9d4-34c45de2fbb8"; // TiMEM-AI
const P_GUID = "c7d9b28e-2ed3-4146-b16e-fc6a7393db99"; // P 计划中

async function api(method: string, path: string, query?: Record<string, string>, body?: unknown) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await resp.json()) as any;
}

const PR_REQ =
  "\n交付要求：在仓库内新建分支完成修改（引用 Gitea 远端 origin），提交并推送后创建 Gitea PR（保持开启不合并），" +
  "PR 链接与分支名写进最终汇报。\n执行者：agent";

const PATCHES: Array<{ guid: string; find: string; replace: string }> = [
  {
    guid: "9551b47b-1986-409c-8712-16418ae86c76",
    find: "执行者：agentd",
    replace: "目标：任意通道新建账号 30 天内具备含 L1 存储的 trial 资源包；回归测试全绿；新建项目绑定账号不再出现 NOT_OPEN 402。" + PR_REQ,
  },
  {
    guid: "74a8d7a5-3f0c-4721-8f27-0d293eae40e2",
    find: "执行者：agentd",
    replace: "目标：402 detail 可直接判定分支与处置动作；不改变状态码与文案主干；测试全绿。" + PR_REQ,
  },
];

try {
  // ① 改两任务描述
  for (const p of PATCHES) {
    const g = await api("GET", `/open-apis/task/v2/tasks/${p.guid}`, { user_id_type: "open_id" });
    if ((g?.code ?? -1) !== 0) { console.log(`读取 ${p.guid.slice(0,8)} 失败: ${g?.msg}`); continue; }
    const desc = g?.data?.task?.description ?? "";
    if (!desc.includes(p.find)) { console.log(`${p.guid.slice(0,8)} 未找到「执行者：agentd」，跳过`); continue; }
    const upd = await api("PATCH", `/open-apis/task/v2/tasks/${p.guid}`, { user_id_type: "open_id" }, {
      update_fields: ["description"], task: { description: desc.replace(p.find, p.replace) },
    });
    console.log(`描述更新 ${p.guid.slice(0,8)}: code=${upd?.code}`);
  }

  // ② 建「⏸ 挂起」组（缺则建）
  const secs = await api("GET", "/open-apis/task/v2/sections", {
    resource_type: "tasklist", resource_id: LIST_GUID, page_size: "50", user_id_type: "open_id",
  });
  let pause = (secs?.data?.items ?? []).find((s: any) => s.name === "⏸ 挂起");
  if (!pause) {
    const cr = await api("POST", "/open-apis/task/v2/sections", { user_id_type: "open_id" },
      { name: "⏸ 挂起", resource_type: "tasklist", resource_id: LIST_GUID });
    pause = cr?.data?.section;
  }
  console.log("⏸ 挂起 组:", pause?.guid ?? "创建失败");

  // ③ P 组里找 3 个挂起任务并挪入
  const pts = await api("GET", "/open-apis/task/v2/tasks", {
    tasklist_guid: LIST_GUID, section_guid: P_GUID, page_size: "50", user_id_type: "open_id",
  });
  const items = pts?.data?.items ?? [];
  console.log("P 组任务数:", items.length);
  let moved = 0;
  for (const t of items) {
    if (!(t.summary ?? "").includes("【挂起】")) continue;
    const mv = await api("POST", `/open-apis/task/v2/tasks/${t.guid}/add_tasklist`, { user_id_type: "open_id" },
      { tasklist_guid: LIST_GUID, section_guid: pause.guid });
    console.log(`  挪「${t.summary.slice(0, 30)}」→ ⏸: code=${mv?.code}`);
    if ((mv?.code ?? -1) === 0) moved++;
  }
  console.log(`共挪 ${moved} 个挂起任务`);
} catch (e) {
  console.error("顶层异常:", e);
  process.exit(1);
}
