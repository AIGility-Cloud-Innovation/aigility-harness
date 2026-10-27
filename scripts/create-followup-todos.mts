/**
 * 建两条后续任务到飞书 P 分组：
 *   T7  → t102308 重跑（续用已有 cec9aae 提交，不得重跑）  ← 催办，置最高优先
 *   T8  → t102312 障碍修复（根因已由代码修复，需结单）
 *
 * 依赖 scripts/feishu-user-token.mts（用户身份，与生产 identity=user 同源）。
 * 防重：summary 前缀 [svc-keepalive] / [followup]。
 */
import { userToken } from "./feishu-user-token.mts";

const LIST_NAME = "AIGility-Cloud-Innovation";
const SECTION_P = "P 计划中";
const PREFIX = "[followup]";

const TODOS: Array<{ key: string; summary: string; description: string }> = [
  {
    key: "T7",
    summary: "【重跑·高优先】t102308 人机决策回路全量：续用已有提交 cec9aae，勿重跑",
    description: [
      "执行者：agent",
      "",
      "【关联】飞书任务 t102308 = 台账 tsk_f741b6ab-c7d1-4874-b8e7-4bb60bcce8fe",
      "（标题：【agent】人机决策回路全量：状态机+播报+回复解析续跑，合并 t102044/t102128）",
      "【本次失败的真正根因】不是任务本身，而是交付链的基线对齐缺陷——",
      "  交付前执行 git merge-base HEAD refs/remotes/origin/agent/t102044-t102128-cce8fe",
      "  该远程分支不存在（工作区分支名 ≠ 远端分支名），报 Not a valid object name → 交付失败。",
      "【根因已修复】pr-finisher 的 detectBaseBranch 已改为优先 origin/main → master → dev，",
      "  忽略本地 agent/* 分支。已在真实工作区验证：merge-base origin/main 成功。",
      "  修复已编译进 dist（2026-10-27 08:57），服务 09:25 加载，现 active。",
      "【关键：工作区已有产出，必须续用】",
      "  工作区 /home/johnny/AI/.worktrees/aigility-harness-cce8fe 分支 agent/t102044-t102128-cce8fe",
      "  已有提交 cec9aae（1 文件 +10/-2）：packages/layer-orchestration/src/task-issue-sync.ts",
      "  内容：决策幂等/防重复提交/写失败回滚——正是本卡要求的「回复解析续跑」核心接线。",
      "  ⚠️ 不可丢弃重跑：必须在此提交之上继续（补测试、补 PR 交付）。",
      "",
      "【要做的】",
      "1. 在工作区 cce8fe 上续用 cec9aae，勿重置、勿重跑；",
      "2. 补齐原卡交付要求：状态机与意图单测、typecheck 0 错误；",
      "3. 推送分支 + 创建 Gitea PR（保持开启不合并），PR 链接写进最终汇报；",
      "4. 验收：对现挂 needs-input 任务真实回复一次「决策」指令，观察台账转 ready、worker 续跑。",
      "",
      "【原卡已知风险】t102044/t102128 均因 codex 30 分钟超时失败，本卡范围更大，",
      "建议拆阶段交付：先最小闭环跑通再补全量。",
      "【原卡边界】不改 worker-team 派发/续跑内核；不实现超时转 failed。",
      "",
      "【参考】docs/t102308重跑说明.md",
    ].join("\n"),
  },
  {
    key: "T8",
    summary: "t102312 障碍修复单：根因已由代码修复，待验证并结单",
    description: [
      "执行者：agent",
      "",
      "【关联】飞书任务 t102312 = 台账 tsk_d23333e3-304a-4f88-ac69-a7dd5c87b4a3",
      "来源失败任务：tsk_40d63e67-9a21-4549-9c16-946569c57927（其上游 tsk_fee5d218-…-b79b3d）",
      "",
      "【这张单是什么】障碍分析员对 t102308 交付失败生成的修复建议单，现 status=planned。",
      "原判定：障碍类别『权限范围』（置信度 high）——**判定错误**，",
      "  实际是 pr-finisher 基线探测缺陷（git merge-base 引用了不存在的远程分支），与权限无关。",
      "",
      "【根因已修复（已完成项）】",
      "  · pr-finisher detectBaseBranch：改为优先 origin/main → master → dev，忽略本地 agent/* 分支；",
      "  · 已补回归测试（origin/HEAD 缺失 + 当前分支为 agent/* → 回退 main）；",
      "  · obstacle-analyst：新增『工具链缺陷』类别，注入诊断证据（避免再误判为权限问题）；",
      "  · worker-team：composeFailureNote 保护尾部【诊断证据】不被 300 字上限截断；",
      "  · 全部单测通过（400/400）、typecheck 0 错误、已提交推送；",
      "  · 真实工作区实测 merge-base origin/main 成功。",
      "",
      "【要做的】",
      "1. 复核上述修复在线上确实生效（服务已加载修复版 dist）；",
      "2. 按本单原『解决方法』逐条核对，标注哪些已由代码修复覆盖、哪些仍需人工；",
      "3. 验证 t102308 重跑后能否正常交付（与 T7 联动，这是本单的最终验收）；",
      "4. 结单：本单描述的根因已消失，关闭它（或转 done）。",
      "",
      "【注意】本单原『解决方法』偏向运维手工操作（检查 origin 配置、git fetch --all、",
      "手动创建引用等），实际正确解法是**代码修复**，不应照单执行手工步骤。",
      "",
      "【参考】docs/服务保活设计-所有权唯一化.md、docs/功能开关对照表.md",
    ].join("\n"),
  },
];

async function main() {
  const T = await userToken();
  console.log("✓ 用户 token 就绪");

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

  const lists = await api("GET", "/open-apis/task/v2/tasklists", undefined, { page_size: "50", user_id_type: "open_id" });
  const list = (lists.data?.items ?? []).find((l: any) => (l.name ?? "").trim() === LIST_NAME);
  if (!list?.guid) throw new Error(`未找到清单「${LIST_NAME}」`);
  console.log(`✓ 清单 guid=${list.guid}`);

  const secs = await api("GET", "/open-apis/task/v2/sections", undefined, {
    resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id",
  });
  const pGuid = (secs.data?.items ?? []).find((s: any) => (s.name ?? "").trim() === SECTION_P)?.guid;
  if (!pGuid) throw new Error("P 分组未找到");

  const existing = await api("GET", `/open-apis/task/v2/tasklists/${list.guid}/tasks`, undefined, {
    completed: "false", page_size: "100", user_id_type: "open_id",
  });
  const have = new Set(
    (existing.data?.items ?? []).map((t: any) => t.summary ?? "").filter((s: string) => s.startsWith(PREFIX)),
  );
  console.log(`  已存在 ${have.size} 条同类`);

  for (const td of TODOS) {
    const summary = `${PREFIX} ${td.summary}`;
    if (have.has(summary)) { console.log(`  ⏭ 已存在：${td.key}`); continue; }
    const cr = await api("POST", "/open-apis/task/v2/tasks", { summary, description: td.description }, { user_id_type: "open_id" });
    if (cr.code !== 0 || !cr.data?.task?.guid) { console.log(`  ❌ ${td.key}: ${cr.code} ${cr.msg}`); continue; }
    const guid = cr.data.task.guid;
    const mv = await api("POST", `/open-apis/task/v2/tasks/${guid}/add_tasklist`, {
      tasklist_guid: list.guid, section_guid: pGuid,
    }, { user_id_type: "open_id" });
    console.log(`  ${mv.code === 0 ? "✅" : "⚠️ "} ${td.key} | guid=${guid} ${mv.code === 0 ? "→ P" : `挪P失败:${mv.msg}`}`);
  }
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });