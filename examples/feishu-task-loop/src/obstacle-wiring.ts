/**
 * obstacle-wiring —— 障碍分析员装配（worker-team 失败 → 归因 → 飞书待审核修复卡）
 *
 * 接线（examples 装配层，2026-10-26）：startWorkerTeamLoop({ onResult }) 的失败结果
 * → runObstacleAnalyst（layer-orchestration，LLM 归因 + 台账落卡）→ 群播报摘要。
 * 飞书建卡：P 计划中分组、不带执行者标记 → plan-gate 下一拍打【待安排执行者】，
 * 人工审核（安排执行者 @姓名 / 改【agent】）后进入下一轮派发。
 *
 * 开关与模型（2026-10-26 改版）：OBSTACLE_ANALYST=0 关闭。归因 LLM 来源
 * 本地优先：Ollama（OLLAMA_URL 缺省 127.0.0.1:11434，OLLAMA_MODEL 缺省
 * qwen3.5:latest，format=json 强制合法 JSON、think=false 关思考链）→ 失败
 * 回落网关 llm-inference（OBSTACLE_ANALYST_MODEL 覆盖模型名）。背景：网关
 * 切思考型模型后 max_tokens=600 被推理吃光，正文空 → 一度全量降级；本地
 * 9B 实测 2-6s 出合法 JSON，归因这种小文本结构化提取不需要网关大模型。
 * OBSTACLE_LLM=gateway 可跳过本地直走网关。
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
  /** 配置清单名（可选；清单位以组织名匹配为主，缺省回落第一个清单） */
  tasklistNames?: string[];
  title: string;
  description: string;
}): Promise<{ guid: string; url?: string } | undefined> {
  const { ctx, orgName, title, description } = opts;
  const tasklistNames = opts.tasklistNames ?? [];
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

/** 本地 Ollama 归因（format=json 强制合法 JSON；think=false 归因不需要思考链）。失败返回 null 由调用方回落。 */
async function callLocalOllama(req: { messages: Array<{ role: string; content: string }>; temperature?: number }): Promise<{ ok: true; value: { text: string } } | { ok: false; error: string } | null> {
  if ((process.env["OBSTACLE_LLM"] ?? "").toLowerCase() === "gateway") return null;
  const base = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";
  const model = process.env["OLLAMA_MODEL"] ?? "qwen3.5:latest";
  try {
    const r = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: false,
        think: false,
        format: "json",
        options: { temperature: req.temperature ?? 0.2, num_predict: 600 },
      }),
      signal: AbortSignal.timeout(Number(process.env["OLLAMA_TIMEOUT_MS"] ?? 120_000)),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { message?: { content?: string } };
    const text = body.message?.content ?? "";
    return text ? { ok: true as const, value: { text } } : null;
  } catch {
    return null; // 本地不可用 → 回落网关
  }
}

/** 网关归因兜底：max_tokens 1200（思考型模型推理开销大，600 会被吃光致正文截断——2026-10-26 降级根因） */
async function callGatewayLlm(ctx: CtxLike, req: { messages: Array<{ role: string; content: string }>; temperature?: number }): Promise<{ ok: true; value: { text: string } } | { ok: false; error: string }> {
  try {
    const v = (await ctx.call({ id: "@cognitive/llm-inference", versionRange: "^1.0.0" }, {
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: 1200,
      model: obstacleAnalystModel(),
    })) as { ok?: boolean; value?: { text?: string }; error?: string };
    if (v?.ok && typeof v.value?.text === "string" && v.value.text) {
      return { ok: true, value: { text: v.value.text } } as const;
    }
    return { ok: false, error: v?.error ?? "llm-inference 未返回" } as const;
  } catch (e) {
    return { ok: false, error: String(e) } as const;
  }
}

/**
 * 生成 onResult 处理器（startWorkerTeamLoop 注入）。失败触发，成功静默；
 * 全链路异常只记日志——障碍分析员绝不拖垮工人循环。
 */
export function makeObstacleAnalystOnResult(opts: {
  ctx: CtxLike;
  registry: TaskRegistry;
  tasklistNames?: string[];
  notify?: (text: string) => Promise<void> | void;
}): (uid: string, result: { ok: boolean; value?: string; error?: string }) => Promise<void> {
  const { ctx, registry, notify } = opts;
  const tasklistNames = opts.tasklistNames ?? [];
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
          // 本地 Ollama 优先（零 token、不依赖网关），失败回落网关（max_tokens 已调大防思考型截断）
          const local = await callLocalOllama(req);
          if (local) return local;
          return callGatewayLlm(ctx, req);
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
