// 把 E2E 验收结论写回飞书任务卡 ca07b2cb-...（PATCH description）
import { InMemoryKernelAdapter } from "../packages/prototype-mode/src/in-memory-kernel.js";
import { LayerId } from "../packages/core/src/index.js";
import { loadEnv } from "../examples/feishu-task-loop/src/env.js";

loadEnv();

const TASK_GUID = process.env.TASK_GUID ?? "";

const DESC = `【验收结论 · 2026-10-25 本机实测】

环境：前端 :3002 / 后端 :8000（PR #273 worktree）/ PG :5433 / Redis :6379

一、已跑通（全部实测，非推断）
1. 单元测试 43/43 通过（含 test_admin_export_targets_user）
2. 管理员导出指定用户：POST /api/console/finance/exports 带 user_id → 200
   - alice 导出 3 行、bob 导出 2 行、表头 25 列、UTF-8 BOM 正常
   - 交叉检查：两份 CSV 均不含对方数据
3. 权限模型正确
   - 管理员（is_admin=true）带 user_id 导出 → 允许
   - 普通用户 alice 带 user_id 导出 bob → 403「需要平台管理员权限」
   - 普通用户不带 user_id 导出自己 → 允许
4. 前端交互闭环（Playwright 实测）
   - 运营看板→用户费用明细→搜索 e2e_alice→选中（列表 3 条）
   - 点「导出账单」→ POST body 含 "user_id":"usr_e2e_alice01" ✅
   - 新标签页跳转 /finance/exports?exportType=bill（符合预期交互）
   - alice 登录导出记录页 → 11 条 → 点下载 → CS​V 917B/3 行内容正确

二、发现缺陷（需修，PR #273 未覆盖）
【缺陷 1 · 阻断级】管理员「导出记录」页永远为空
  list_exports(user_id) 只查 FinanceExportTask.user_id == 当前登录人。
  管理员导出 alice 的数据时，任务记在 alice 名下（creator 才是管理员），
  因此管理员点导出→跳到导出记录→看到「暂无数据」（实测 total=0）。
  修复建议：list_exports 对 is_admin 放开（或按 creator 查），
  并给表加 create_by 字段记录发起人，列表页支持「我发起的 / 全部」。

三、环境说明
本机无腾讯云 COS 凭据，端到端下载用本地签名存储替身（E2E_LOCAL_EXPORT_STORAGE=1，
文件落 ~/AI/e2e-admin-export/exports，8099 签名服务）。
业务逻辑（筛选/隔离/CSV 生成/权限）与生产同一条代码路径，仅存储后端替换。
生产环境仍需 COS 凭据验证一次真实上传下载。

四、复现脚本
bash ~/AI/e2e-admin-export/verify-local.sh        # 单测 + 真库隔离验证
python3 ~/AI/e2e-admin-export/verify-visual.py    # 前端视觉（需 CONSOLE_PASS）`;

async function main(): Promise<void> {
  const kernel = new InMemoryKernelAdapter();
  await kernel.init({ mode: "prototype", profile: "e2e-report", autoHotSwap: false, healthCheckIntervalMs: 60_000 });
  const { feishuApiProvider, feishuApiService } = await import("../packages/layer-action/src/index.js");
  await kernel.registry.register(feishuApiService, feishuApiProvider);
  const ctx = kernel.createContext("e2e-report", LayerId.Action);
  const call = async (req: Record<string, unknown>) => {
    const r = await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req);
    return r.ok ? (r.value as { code?: number; data?: unknown; msg?: string }) : { code: -1, msg: String(r.error) };
  };

  const res = await call({
    method: "PATCH",
    path: `/open-apis/task/v2/tasks/${TASK_GUID}`,
    query: { user_id_type: "open_id" },
    body: { update_fields: ["description"], task: { description: DESC } },
    identity: "user",
  });
  console.log("PATCH 结果:", JSON.stringify(res).slice(0, 400));

  const chk = await call({
    method: "GET",
    path: `/open-apis/task/v2/tasks/${TASK_GUID}`,
    query: { user_id_type: "open_id" },
    identity: "user",
  });
  const d = ((chk as any)?.data?.task?.description ?? "") as string;
  console.log("回读长度:", d.length, "| 含验收结论:", d.includes("验收结论"), "| 含缺陷1:", d.includes("缺陷 1"));
}

main().catch((e) => { console.error(e); process.exit(1); });
