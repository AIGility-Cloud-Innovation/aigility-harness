/**
 * L4 编排规划层: task-pipeline — 群聊 → 任务 → 工单 → PR 提醒 流水线
 *
 * 定时流程（每 tick）：
 *   1. 取出监听缓冲里的群聊消息（D1 feishu-ingress passive 模式喂入）
 *   2. 调 @cognitive/llm-inference 判定：哪些是待执行任务（标题/优先级/仓库）
 *   3. 与 Gitea 各仓库 open 工单 + 飞书任务查重（词集 Jaccard 相似度）
 *   4. 新任务 → 建 Gitea 工单（标题前缀 [P0-P3]，正文带来源）→ 群播报
 *   5. 轮询各仓库 open PR → 发现新 PR → 群提醒真人合并
 *
 * 只管理，不执行：本服务不写代码，执行由 codex 系工人/真人完成。
 *
 * LLM 判定容错：LLM 不可用时消息保留在缓冲（有上限），下个 tick 重试。
 * 状态（已见 PR、缓冲）存 ctx.getState，重启后 PR 会重新提醒一次，可接受。
 */

import {
  LayerId,
  PluginState,
  CarrierKind,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  PluginManifest,
  SeamContext,
  Result,
  HealthStatus,
  CapabilityRef,
} from "@aigility-harness/core";

// ── 消费引用 ─────────────────────────────────────────────────────

export const llmInferenceRef: CapabilityRef = {
  id: "@cognitive/llm-inference",
  versionRange: "^1.0.0",
};
export const feishuApiRef: CapabilityRef = {
  id: "@action/feishu-api",
  versionRange: "^1.0.0",
};
export const giteaApiRef: CapabilityRef = {
  id: "@action/gitea-api",
  versionRange: "^1.0.0",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface TaskPipelineRequest {
  /** 汇总周期毫秒，默认 600000（10 分钟） */
  intervalMs?: number;
  /** 单批最多送给 LLM 的消息条数，默认 40 */
  maxBatch?: number;
  /** 缓冲上限（LLM 不可用时防无限膨胀），默认 200 */
  bufferLimit?: number;
  /** 监听的 Gitea 仓库（owner/name），任务落到第一个，除非 LLM 判定归属 */
  repos: string[];
  /** 群播报目标会话（chatId）；未设则不播报，仅建单 */
  notifyChatId?: string;
  /** 查重相似度阈值，默认 0.5 */
  dedupThreshold?: number;
  /** 判定用模型名，默认读 env TASK_PIPELINE_MODEL，再退 "glm-4-flash" */
  model?: string;
  /** 立即执行一次 tick（默认 true，方便启动即验证） */
  runOnStart?: boolean;
}

export interface TaskPipelineResponse {
  ok: boolean;
  intervalMs: number;
  /** 停止流水线 */
  stop: () => void;
}

export const taskPipelineService: ServiceDefinition<TaskPipelineRequest, TaskPipelineResponse> = {
  id: "@orchestration/task-pipeline",
  version: "1.0.0",
  layer: LayerId.Orchestration,
  description:
    "群聊监听汇总 → LLM 判定任务 → Gitea 工单去重入库 → PR 轮询群提醒（只管理不执行）",
};

// ── 监听缓冲（装配层喂入） ────────────────────────────────────────

export interface CollectedMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  ts: number;
}

const buffer: CollectedMessage[] = [];

/** 装配层把 ingress passive 收集的消息推入缓冲 */
export function collectMessage(m: CollectedMessage): void {
  buffer.push(m);
}

/** 仅供测试：清空缓冲 */
export function clearBuffer(): void {
  buffer.length = 0;
}

// ── 纯函数（导出供单测） ─────────────────────────────────────────

/** 归一化标题：小写、去标点符号、压空白 */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 词集 Jaccard 相似度；中文无空格分词，统一用字符二元组（含中英混合）；任一为空返回 0 */
export function jaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = normalizeTitle(s).replace(/ /g, "");
    const set = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (t.length === 1) set.add(t);
    return set;
  };
  const sa = grams(a);
  const sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export interface CandidateTask {
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  repo?: string;
  reason?: string;
}

/** 从 LLM 文本响应中解析 JSON 数组（容忍 ```json 包裹与前后闲话） */
export function parseCandidateTasks(text: string): CandidateTask[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as Array<Record<string, unknown>>;
    const valid = new Set(["P0", "P1", "P2", "P3"]);
    return arr
      .filter((o) => typeof o.title === "string" && (o.title as string).trim())
      .map((o) => ({
        title: String(o.title).trim().slice(0, 120),
        priority: (valid.has(String(o.priority)) ? String(o.priority) : "P2") as CandidateTask["priority"],
        repo: typeof o.repo === "string" && o.repo ? o.repo : undefined,
        reason: typeof o.reason === "string" ? o.reason : undefined,
      }));
  } catch {
    return [];
  }
}

/** 判定 prompt（system + user 消息体） */
export function buildJudgeMessages(
  texts: string[],
  repos: string[],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        `你是研发团队的群聊任务整理员。给定一批群聊消息，判断哪些包含"需要开发的任务/需求/bug"。\n` +
        `输出纯 JSON 数组（不要任何其他文字），每项：{"title":"任务标题(简洁动宾短语)","priority":"P0|P1|P2|P3","repo":"归属仓库(从列表选)","reason":"一句话依据"}。\n` +
        `规则：闲聊/寒暄/纯讨论无行动项 → 不要输出；同一主题多条消息合并为一项；` +
        `P0=线上事故, P1=紧急重要, P2=一般需求, P3=低优。\n` +
        `仓库列表：${repos.join(", ")}`,
    },
    {
      role: "user",
      content: texts.map((t, i) => `[${i + 1}] ${t}`).join("\n"),
    },
  ];
}

/** 从一批候选里去掉与已有标题重复的（阈值以上视为重复） */
export function filterDuplicates(
  candidates: CandidateTask[],
  existingTitles: string[],
  threshold: number,
): CandidateTask[] {
  return candidates.filter((c) => {
    const dup = existingTitles.find((t) => jaccard(t, c.title) >= threshold);
    return !dup;
  });
}

// ── Provider 实现 ────────────────────────────────────────────────

interface PipelineRuntime {
  timer: ReturnType<typeof setInterval> | null;
  seenPrs: Set<string>;
  started: boolean;
}

const runtime: PipelineRuntime = { timer: null, seenPrs: new Set(), started: false };

/** 群播报函数（由装配层注入：ingress 返回的 send）。未注入则只建单不播报。 */
let notifySend: ((chatId: string, text: string) => Promise<void>) | undefined;

export function setNotifySend(fn: (chatId: string, text: string) => Promise<void>): void {
  notifySend = fn;
}

/** action 语义 → gitea-api 透传请求（Gitea v1 路径） */
function giteaRequest(req: Record<string, unknown>): Record<string, unknown> | null {
  const repo = String(req.repo ?? "");
  switch (req.action) {
    case "list_issues": {
      const q: Record<string, string | number> = {
        state: String(req.state ?? "open"),
        limit: Number(req.limit ?? 20),
        type: "issues",
      };
      if (req.labels) q.labels = String(req.labels);
      return { method: "GET", path: `/api/v1/repos/${repo}/issues`, query: q };
    }
    case "create_issue":
      return {
        method: "POST",
        path: `/api/v1/repos/${repo}/issues`,
        body: { title: req.title, body: req.body ?? "", ...(req.labels ? { labels: req.labels } : {}) },
      };
    case "list_prs":
      return {
        method: "GET",
        path: `/api/v1/repos/${repo}/pulls`,
        query: { state: String(req.state ?? "open"), limit: Number(req.limit ?? 20) },
      };
    default:
      return null;
  }
}

async function callGitea(
  ctx: SeamContext,
  req: Record<string, unknown>,
): Promise<{ status: number; data: unknown } | null> {
  const passthrough = giteaRequest(req);
  if (!passthrough) {
    console.error(`[task-pipeline] 不支持的 gitea action: ${String(req.action)}`);
    return null;
  }
  const r = (await ctx.call(giteaApiRef, passthrough)) as {
    ok: boolean;
    value?: { status: number; data: unknown };
    error?: string;
  };
  if (!r.ok) {
    console.error(`[task-pipeline] gitea call failed: ${r.error}`);
    return null;
  }
  return r.value ?? null;
}

async function notify(ctx: SeamContext, chatId: string | undefined, send: ((chatId: string, text: string) => Promise<void>) | undefined, text: string): Promise<void> {
  if (!chatId || !send) return;
  try {
    await send(chatId, text);
  } catch (e) {
    console.error(`[task-pipeline] notify failed: ${String(e)}`);
  }
}

export const taskPipelineProvider: Provider<TaskPipelineRequest, TaskPipelineResponse> = {
    service: taskPipelineService,
    name: "orchestration-task-pipeline",
    state: PluginState.Active,

    async execute(
      request: TaskPipelineRequest,
      ctx: SeamContext,
    ): Promise<Result<TaskPipelineResponse>> {
      const intervalMs = request.intervalMs ?? 600_000;
      const maxBatch = request.maxBatch ?? 40;
      const bufferLimit = request.bufferLimit ?? 200;
      const repos = request.repos;
      const threshold = request.dedupThreshold ?? 0.5;
      const model = request.model ?? process.env.TASK_PIPELINE_MODEL ?? "glm-4-flash";

      if (runtime.timer) clearInterval(runtime.timer);

      const tick = async (): Promise<void> => {
        try {
          // ── 1. 汇总判定 ──
          if (buffer.length > 0) {
            const batch = buffer.splice(0, maxBatch);
            const texts = batch.map(
              (m) => `${new Date(m.ts).toISOString().slice(11, 16)} ${m.text}`,
            );
            const llm = (await ctx.call(llmInferenceRef, {
              model,
              messages: buildJudgeMessages(texts, repos),
              temperature: 0.2,
              max_tokens: 2000,
            })) as { ok: boolean; value?: { text?: string }; error?: string };

            let candidates: CandidateTask[] = [];
            if (llm.ok && llm.value?.text) {
              candidates = parseCandidateTasks(llm.value.text);
            } else {
              // LLM 不可用：消息放回缓冲头部，等下个 tick 重试
              buffer.unshift(...batch);
              if (buffer.length > bufferLimit) buffer.length = bufferLimit;
              console.error(`[task-pipeline] LLM 不可用，${batch.length} 条消息保留缓冲: ${llm.error ?? "空响应"}`);
            }

            if (candidates.length > 0) {
              // ── 2. 查重：Gitea open 工单 + 飞书任务 ──
              const existingTitles: string[] = [];
              for (const repo of repos) {
                const r = await callGitea(ctx, { action: "list_issues", repo, state: "open", limit: 50 });
                if (r && Array.isArray(r.data)) {
                  for (const it of r.data as Array<{ title?: string }>) {
                    if (it.title) existingTitles.push(it.title);
                  }
                }
              }
              const fr = (await ctx.call(feishuApiRef, {
                method: "GET",
                path: "/open-apis/task/v2/tasks",
                query: { page_size: 50, user_id_type: "open_id" },
                identity: "user",
              })) as { ok: boolean; value?: { data?: { items?: Array<{ summary?: string; status?: string }> } } };
              if (fr.ok) {
                for (const t of fr.value?.data?.items ?? []) {
                  if (t.status !== "done" && t.summary) existingTitles.push(t.summary);
                }
              }

              // ── 3. 建工单 ──
              const fresh = filterDuplicates(candidates, existingTitles, threshold);
              const created: string[] = [];
              for (const c of fresh) {
                const repo = c.repo && repos.includes(c.repo) ? c.repo : repos[0];
                const r = await callGitea(ctx, {
                  action: "create_issue",
                  repo,
                  title: `[${c.priority}] ${c.title}`,
                  body: `> 来源：飞书群聊自动汇总（${new Date().toISOString()}）\n>\n> 判定依据：${c.reason ?? "LLM 判定为待执行任务"}\n\n由 @orchestration/task-pipeline 自动创建，请负责人认领。`,
                });
                if (r && typeof r.data === "object" && r.data !== null) {
                  const issue = r.data as { number?: number; html_url?: string };
                  created.push(`${repo}#${issue.number ?? "?"} [${c.priority}] ${c.title}`);
                }
              }
              if (created.length > 0) {
                console.log(`[task-pipeline] 新建工单 ${created.length} 条`);
                await notify(ctx, request.notifyChatId, notifySend, `🆕 群聊汇总：识别到 ${created.length} 条新任务，已建工单：\n${created.map((s) => `• ${s}`).join("\n")}`);
              } else {
                console.log(`[task-pipeline] 判定 ${candidates.length} 条候选，全部与现有任务/工单重复`);
              }
            }
          } else if (buffer.length > bufferLimit) {
            buffer.length = bufferLimit;
          }

          // ── 4. PR 轮询提醒 ──
          if (request.notifyChatId) {
            const newPrs: string[] = [];
            for (const repo of repos) {
              const r = await callGitea(ctx, { action: "list_prs", repo, state: "open", limit: 30 });
              if (r && Array.isArray(r.data)) {
                for (const pr of r.data as Array<{ number?: number; title?: string; html_url?: string }>) {
                  const key = `${repo}#${pr.number}`;
                  if (!runtime.seenPrs.has(key)) {
                    runtime.seenPrs.add(key);
                    // 首个 tick 只记录基线不提醒，避免每次重启轰炸
                    if (runtime.started) {
                      newPrs.push(`${repo}!${pr.number} ${pr.title ?? ""}`);
                    }
                  }
                }
              }
            }
            if (newPrs.length > 0) {
              await notify(ctx, request.notifyChatId, notifySend, `🔀 检测到 ${newPrs.length} 个待合并 PR：\n${newPrs.map((s) => `• ${s}`).join("\n")}`);
            }
          }
        } catch (e) {
          console.error(`[task-pipeline] tick error: ${String(e)}`);
        }
      };

      if (request.runOnStart !== false) {
        runtime.started = false;
        void tick().then(() => {
          runtime.started = true;
        });
      } else {
        runtime.started = true;
      }
      runtime.timer = setInterval(() => void tick(), intervalMs);

      return ok({
        ok: true,
        intervalMs,
        stop: () => {
          if (runtime.timer) clearInterval(runtime.timer);
          runtime.timer = null;
        },
      });
    },

    async health(): Promise<HealthStatus> {
      return {
        healthy: runtime.timer !== null,
        detail: runtime.timer ? "running" : "not started",
        checkedAt: new Date().toISOString(),
      };
    },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@orchestration/task-pipeline",
  layer: LayerId.Orchestration,
  description: "编排规划层：群聊→任务→工单→PR提醒 流水线（只管理不执行）",
  version: "1.0.0",
  provides: [taskPipelineService],
  consumes: [llmInferenceRef, feishuApiRef, giteaApiRef],
  preferredCarrier: CarrierKind.Thread,
};
