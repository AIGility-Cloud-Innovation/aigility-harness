/**
 * obstacle-wiring —— 障碍分析员装配（worker-team 失败 → 归因 → 飞书待审核修复卡）
 *
 * 接线（examples 装配层，2026-10-26）：startWorkerTeamLoop({ onResult }) 的失败结果
 * → runObstacleAnalyst（layer-orchestration，LLM 归因 + 台账落卡）→ 群播报摘要。
 * 飞书建卡：P 计划中分组、不带执行者标记 → plan-gate 下一拍打【待安排执行者】，
 * 人工审核（安排执行者 @姓名 / 改【agent】）后进入下一轮派发。
 *
 * 开关与模型：OBSTACLE_ANALYST=0 关闭；OBSTACLE_ANALYST_MODEL 覆盖（缺省
 * bigmodel-glm-5.3-flash，与 worker-team 规划模型同源）。
 */
import { TaskRegistry } from "@aigility-harness/layer-orchestration";
import {
  runObstacleAnalyst, obstacleAnalystEnabled, obstacleAnalystModel, extractFailureMember,
} from "@aigility-harness/layer-orchestration";

/** 最小 SeamContext 结构（避免装配层反向引包类型；真 ctx 结构兼容） */
interface CtxLike {
  call: (ref: { id: string; versionRange: string }, req: Record<string, unknown>) => Promise<unknown>;
}

interface FeishuResultLike {
  ok?: boolean;
  error?: string;
  value?: { code?: number; msg?: string; data?: unknown };
}

async function callFeishu(ctx: CtxLike, req: Record<string, unknown>): Promise<FeishuResultLike> {
  return (await ctx.call({ id: "@action/feishu-api", versionRange: "^1.0.0" }, req)) as FeishuResultLike;
}

/** 建 P 组修复卡：清单优先任务归属组织名，回落配置的清单名 */
async function createRepairCard(opts: {
  ctx: CtxLike;
  orgName?: string;
  tasklistNames: string[];
  title: string;
  description: string;
}): Promise<{ guid: string; url?: string } | undefined> {
  const { ctx, orgName, tasklistNames, title, description } = opts;
  const lists = await callFeishu(ctx, {
    method: "GET", path: "/open-apis/task/v2/tasklists", query: { page_size: "50" }, identity: "user",
  });
  const items = ((lists.value?.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
  const list = items.find((x) => x.name === orgName) ?? items.find((x) => tasklistNames.includes(x.name ?? "")) ?? items[0];
  if (!list?.guid) {
    console.error("[obstacle-analyst] 找不到任务清单（org=%s 配置=%s）", orgName ?? "-", tasklistNames.join(","));
    return undefined;
  }
  const secs = await callFeishu(ctx, {
    method: "GET", path: "/open-apis/task/v2/sections",
    query: { resource_type: "tasklist", resource_id: list.guid, page_size: "50", user_id_type: "open_id" },
    identity: "user",
  });
  const secItems = ((secs.value?.data as { items?: Array<{ guid?: string; name?: string }> })?.items ?? []);
  const planSection = secItems.find((x) => (x.name ?? "").startsWith("P"));
  const cr = await callFeishu(ctx, {
    method: "POST", path: "/open-apis/task/v2/tasks",
    query: { user_id_type: "open_id" }, identity: "user",
    body: { summary: title.slice(0, 100), description },
  });
  const task = ((cr.value?.data as { task?: { guid?: string } })?.task) ?? undefined;
  const guid = task?.guid;
  if (!guid || (cr.value?.code ?? -1) !== 0) {
    console.error(`[obstacle-analyst] 建卡失败: code=${cr.value?.code} ${cr.value?.msg ?? cr.error ?? ""}`);
    return undefined;
  }
  if (planSection?.guid) {
    await callFeishu(ctx, {
      method: "POST", path: `/open-apis/task/v2/tasks/${guid}/add_tasklist`,
      query: { user_id_type: "open_id" }, identity: "user",
      body: { tasklist_guid: list.guid, section_guid: planSection.guid },
    });
  }
  return { guid, url: `https://www.feishu.cn/task/${guid}` };
}

/**
 * 生成 onResult 处理器（startWorkerTeamLoop 注入）。失败触发，成功静默；
 * 全链路异常只记日志——障碍分析员绝不拖垮工人循环。
 */
export function makeObstacleAnalystOnResult(opts: {
  ctx: CtxLike;
  registry: TaskRegistry;
  tasklistNames: string[];
  notify?: (text: string) => Promise<void> | void;
}): (uid: string, result: { ok: boolean; value?: string; error?: string }) => Promise<void> {
  const { ctx, registry, tasklistNames, notify } = opts;
  return async (uid, result) => {
    if (result.ok) return;
    if (!obstacleAnalystEnabled()) return;
    try {
      const failed = registry.get(uid);
      if (!failed) {
        console.error(`[obstacle-analyst] 失败任务不在台账（${uid}），跳过归因`);
        return;
      }
      const failure = { member: extractFailureMember(result.error ?? ""), error: result.error ?? "" };
      // 同仓近期失败史（同类模式识别输入；失败态里排除本任务）
      const siblings = registry
        .list({ status: ["failed"] })
        .filter((t) => t.uid !== uid && t.projectRef && t.projectRef === failed.projectRef)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 3)
        .map((t) => ({ uid: t.uid, note: t.note }));

      const r = await runObstacleAnalyst({
        registry,
        failedUid: uid,
        failure,
        llm: async (req) => {
          try {
            const v = (await ctx.call({ id: "@cognitive/llm-inference", versionRange: "^1.0.0" }, {
              ...req, model: req.model ?? obstacleAnalystModel(),
            })) as { ok?: boolean; value?: { text?: string }; error?: string };
            if (v?.ok && v.value) return { ok: true, value: v.value } as const;
            return { ok: false, error: v?.error ?? "llm-inference 未返回" } as const;
          } catch (e) {
            return { ok: false, error: String(e) } as const;
          }
        },
        createCard: (follow) => createRepairCard({
          ctx,
          orgName: failed.projectRef?.split("/")[0],
          tasklistNames,
          title: follow.title,
          description: follow.description,
        }),
        siblingFailures: siblings,
      });

      if (!r.ok) {
        console.error(`[obstacle-analyst] 归因失败: ${r.error}`);
        return;
      }
      const { analysis, degraded, skipped, uid: followUid } = r.value;
      const tag = `🧯 障碍分析员：${uid.slice(-6)}「${failed.title.slice(0, 30)}」`;
      if (skipped) {
        await notify?.(`${tag} 已有待审核修复卡（${followUid?.slice(-6) ?? "?"}），不重复建卡。`);
        return;
      }
      await notify?.(
        `${tag} 失败已归因【${analysis.category}${degraded ? "·降级" : ""}】→ 修复卡 ${followUid?.slice(-6) ?? "?"} 已建（P 组待审核）\n` +
        `关键因素：${analysis.key_factors[0] ?? "-"}\n` +
        `解决方法：${analysis.resolution.slice(0, 120)}\n` +
        `审核方式：群里「安排执行者 编号 @姓名」走人工，或改卡标题为【agent】开头免工单放行。`,
      );
    } catch (e) {
      console.error(`[obstacle-analyst] 处理失败结果异常（不影响工人循环）: ${String(e)}`);
    }
  };
}
