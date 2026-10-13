/**
 * 一次性脚本：把 L1 权益补全两任务建进飞书清单 TiMEM-AI（P 计划中），等对齐器收编。
 * 与 feishu-task-loop 同款身份（user token，getFreshUserToken 自动续期回写）。
 * 用法: cd /home/johnny/AI/aigility-harness && set -a && source .env && set +a && \
 *   ./examples/feishu-task-loop/node_modules/.bin/tsx examples/feishu-task-loop/scripts/create-l1-entitlement-tasks.ts
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

// ① 清单
const listsResp = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
const list = (listsResp?.data?.items ?? []).find((x: any) => x.name === ORG);
if (!list) throw new Error(`清单「${ORG}」不存在`);
console.log(`清单: ${list.name} guid=${list.guid}`);

// ② 分组（缺则建，与 task-issue-sync 同款端点形状）
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

// ③ 两任务（五要素齐全：项目=标题前缀 / 执行者 / 现状 / 过程方法 / 目标）
const TASKS = [
  {
    summary: `[${ORG}/timem-platform-backend] 新账号开通即赠记忆资源包（补全 console/apikey/oauth 建号路径的 trial 发放）`,
    description:
      "现状：trial 资源包发放（ensure_trial_plan_for_user，含 memory_l1_storage 行，30 天）只挂在 user/api.py 的 8 处自助注册/登录入口；" +
      "console 代建、apikey 直发、oauth register_client 三条建号路径从不触发，这类账号 finance_resource_packages 无 memory_l1_storage 行，" +
      "调记忆接口直接撞 402 MEMORY_L1_STORAGE_NOT_OPEN（线上项目绑定账号「已建未通」的根因）。\n" +
      "过程方法：在 console 建号服务与 apikey 创建流程（含 oauth register_client）的成功路径上补挂 ensure_trial_plan_for_user" +
      "（函数已幂等：已有有效订阅/已领过自动 skip）；补单测覆盖四条建号路径的发放与幂等跳过。\n" +
      "目标：任意通道新建账号 30 天内具备含 L1 存储的 trial 资源包；回归测试全绿；新建项目绑定账号不再出现 NOT_OPEN 402。\n" +
      "执行者：agentd",
  },
  {
    summary: `[${ORG}/timem-platform-backend] 记忆权益 402 响应体增强（EXPIRED/NOT_OPEN 分支带 expire_at 与用量）`,
    description:
      "现状：assert_l1_storage_available 抛的三种 402 detail 只有 code+message+购买链接；LIMIT 分支有 used/quota_total，" +
      "但 EXPIRED/NOT_OPEN 分支无 expire_at 与历史用量，用户无法自助区分「没买过/已过期/已用尽」，排查成本高。\n" +
      "过程方法：EXPIRED 分支查该账号最近一条 memory_l1_storage 资源包的 expire_at 写入 detail.usage；" +
      "NOT_OPEN 分支 usage 保持全 0 并补「该账号从未持有 memory_l1_storage 资源包」说明；message 附账号脱敏尾号便于对账；单测断言三分支 detail 字段形状。\n" +
      "目标：402 detail 可直接判定分支与处置动作；不改变状态码与文案主干；测试全绿。\n" +
      "执行者：agentd",
  },
];

for (const t of TASKS) {
  const cr = await api("POST", "/open-apis/task/v2/tasks", { user_id_type: "open_id" }, {
    summary: t.summary,
    description: t.description,
  });
  if ((cr?.code ?? -1) !== 0) {
    console.error(`建任务失败: code=${cr?.code} ${cr?.msg}`);
    continue;
  }
  const task = cr?.data?.task;
  console.log(`已建: ${t.summary.slice(0, 46)}… guid=${task.guid}`);

  const at = await api("POST", `/open-apis/task/v2/tasks/${task.guid}/add_tasklist`, { user_id_type: "open_id" },
    { tasklist_guid: list.guid, section_guid: section.guid });
  console.log(`  挂清单+P组: code=${at?.code} ${at?.msg ?? ""}`);
}
console.log("完成。对齐器 30 分钟/拍收编 → 五要素放行 ready → worker-team 认领。");
