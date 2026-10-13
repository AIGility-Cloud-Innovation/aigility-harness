/**
 * 一次性脚本：登记「reversed 状态展示缺口」任务进飞书清单 TiMEM-AI（P 计划中），等对齐器收编。
 * 与 feishu-task-loop 同款身份（user token，getFreshUserToken 自动续期回写）。
 * 用法: cd /home/johnny/AI/aigility-harness && set -a && source .env && set +a && \
 *   ./examples/feishu-task-loop/node_modules/.bin/tsx examples/feishu-task-loop/scripts/create-reversed-status-task.ts
 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";

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

const ORG = "TiMEM-AI";
const P_SECTION = "P 计划中"; // 与 SECTION_NAMES.plan 一致
const TARGET_LIST = "timem_console_frontend"; // 前端仓（该缺口在前端展示层）

// ① 清单
const listsResp = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
const list = (listsResp?.data?.items ?? []).find((x: any) => x.name === ORG);
if (!list) throw new Error(`清单「${ORG}」不存在`);
console.log(`清单: ${list.name} guid=${list.guid}`);

// ② 分组（缺则建）
const secsResp = await api("GET", "/open-apis/task/v2/sections", {
  resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id",
});
let section = (secsResp?.data?.items ?? []).find((x: any) => x.name === P_SECTION);
if (!section) {
  const cr = await api("POST", "/open-apis/task/v2/sections", { user_id_type: "open_id" },
    { name: P_SECTION, resource_type: "tasklist", resource_id: list.guid });
  section = cr?.data?.section;
}
if (!section) throw new Error(`分组「${P_SECTION}」不存在且创建失败`);
console.log(`分组: ${section.name} guid=${section.guid}`);

// ③ 任务（五要素齐全：项目=标题前缀 / 执行者 / 现状 / 过程方法 / 目标）
const summary = `[${ORG}/${TARGET_LIST}] 账单状态列补 reversed（已冲销）展示：筛选项+类型+渲染三处`;

const description =
  "现状：后端账单默认口径排除 reversed（已冲销），但支持显式查询——finance_service.py:1185 注释明确「要审计冲销账单请显式传 status=reversed」；" +
  "而控制台前端把状态写死为两值：src/types/finance.d.ts:200 `export type BillStatus = 'success' | 'failed'`，状态筛选下拉只有 success/failed 两项" +
  "（pages/finance/bills/components/BillsTable.vue:52-53），且状态列渲染逻辑为 `const isFailed = row.status === 'failed'`，非 failed 一律显示绿色「已扣费」" +
  "（BillsTable.vue:294 列表列 + 127-133 详情行）。后果：一笔已全额退款、金额为负的 reversed 冲销账单，一旦出现在视图里（如 URL 带 status=reversed、" +
  "或后续新增筛选项），会被渲染成绿色「已扣费」，正是 2026-09-28「8 条 reversed 旧账让 8 月合计虚高 604.08 元」的同源展示层风险。\n" +
  "过程方法：① src/types/finance.d.ts 的 BillStatus 增补 'reversed'（并核对所有引用处类型收窄不破编译）；" +
  "② BillsTable.vue 状态筛选下拉补第三项「已冲销」（value=reversed）；" +
  "③ 状态列与详情行渲染改为三分支映射：failed→「扣费失败」（danger）、reversed→「已冲销」（default/灰色）、其余→「已扣费」（success）；" +
  "④ locale zh_CN/en_US 补 statusReversed 词条；⑤ 补单测断言三种状态渲染正确（含未知状态兜底不误报已扣费）。\n" +
  "边界：仅前端展示与筛选，禁止改动后端 status 值、禁止把 reversed 混入默认口径、禁止动 _bill_list_conditions 与合计逻辑；" +
  "reversed 详情行的金额为负属预期，不要「修正」为正数。\n" +
  "目标：账单列表/详情可正确呈现并筛选 reversed 冲销账单；任何非 success/failed 的状态不再误显示为「已扣费」；typecheck 与单测全绿。\n" +
  "执行者：agentd";

const cr = await api("POST", "/open-apis/task/v2/tasks", { user_id_type: "open_id" }, { summary, description });
if ((cr?.code ?? -1) !== 0) {
  console.error(`建任务失败: code=${cr?.code} ${cr?.msg}`);
  process.exit(1);
}
const task = cr?.data?.task;
console.log(`已建: ${summary.slice(0, 46)}… guid=${task.guid}`);

const at = await api("POST", `/open-apis/task/v2/tasks/${task.guid}/add_tasklist`, { user_id_type: "open_id" },
  { tasklist_guid: list.guid, section_guid: section.guid });
console.log(`  挂清单+P组: code=${at?.code} ${at?.msg ?? ""}`);
console.log("完成。对齐器收编 → 五要素放行 ready → worker-team 认领。");