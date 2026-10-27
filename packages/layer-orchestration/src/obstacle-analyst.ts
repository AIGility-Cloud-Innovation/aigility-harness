/**
 * obstacle-analyst —— 障碍分析员（任务失败 → 归因 → 待审核修复卡）
 *
 * 定位（2026-10-26 设计）：worker-team 的失败目前是「留 note 终态 + 群里一行 ❌」，
 * 归因与重派全靠人工回忆。本模块在失败发生时自动：
 *   ① 采集现场：任务五要素 + 失败成员/错误原文 + 同仓近期失败史（同类失败模式识别）；
 *   ② LLM 归因：输出结构化 {类别/关键因素/解决方法/预防/建议执行方/置信度}；
 *      LLM 不可用时降级归因（原文错误 + 人工分析指引），分析链不因网关问题中断；
 *   ③ 落账：失败任务 note 追加归因摘要；新建「障碍修复」任务（planned）挂
 *      related.obstacle-source=失败任务 uid，飞书卡 origin 与 plan-gate 合流；
 *   ④ 人工审核门：修复卡不带任何执行者标记 → plan-gate 打【待安排执行者】留 P，
 *      人工「安排执行者 @姓名」或改 agent 后才进入下一轮派发。
 *
 * 防噪：同一失败任务已存在非终态修复卡 → 跳过（不重复建卡）；
 *      描述净化：执行者[:：] → 执行方:（防止分析文本里的建议被
 *      plan-gate 误判为「执行者：agent」而绕过人工审核自动放行）。
 */
import { ok, err } from "@aigility-harness/core";
import type { Result, TaskRecord } from "@aigility-harness/core";
import type { TaskRegistry } from "./task-registry.js";

/** 障碍类别枚举（提示词约束 + 解析兜底） */
export const OBSTACLE_CATEGORIES = [
  "环境依赖", "模型网关", "凭证认证", "代码缺陷", "任务描述不清",
  "超时资源", "外部服务", "权限范围", "工具链缺陷", "其他",
] as const;
export type ObstacleCategory = (typeof OBSTACLE_CATEGORIES)[number];

export interface ObstacleAnalysis {
  category: ObstacleCategory;
  /** 关键障碍因素（1-3 条，每条一句话） */
  key_factors: string[];
  /** 解决此障碍的关键方法（可执行步骤） */
  resolution: string;
  /** 预防建议（可选） */
  prevention?: string;
  /** 建议执行方：agent=可再派工人 / 人工=需人判断 / 运维=基础设施操作 */
  suggested_executor: "agent" | "人工" | "运维";
  confidence: "high" | "medium" | "low";
}

export interface ObstacleFailure {
  /** 失败工人成员 id（codex/claude/pi…） */
  member: string;
  /** 失败原文（worker-team 结果错误串） */
  error: string;
  /**
   * 原始诊断证据（可选）——失败链路的行级日志，供归因定位根因。
   *
   * 2026-10-27 复盘：只喂「下游症状 + 一句结论」时，模型无法定位根因，只能按
   * 「仓库/分支/权限→权限范围」规则把 git 类报错一律归到权限范围，并给出
   * 「检查 remote url / git fetch --all」这类**偏离处方**。补上原始证据后
   * （如 detectBaseBranch 的探测级联、实际执行的 git 命令原文、"工作区无新改动"
   * 只是务实输出而工人已落盘），模型才有据可依。生产者见 pr-finisher.buildBaselineEvidence。
   */
  evidence?: string;
}

export interface ObstacleLlmRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
}
export type ObstacleLlm = (req: ObstacleLlmRequest) => Promise<Result<{ text?: string }>>;

/** 从 "[codex] 执行失败 → xxx" 形态提取成员 id（提取失败回退 "unknown"） */
export function extractFailureMember(error: string): string {
  const m = (error ?? "").match(/^\[([A-Za-z0-9_-]+)\]\s/);
  return m ? m[1] : "unknown";
}

/** 人工审核门防线：把「执行者：」改写为「执行方:」，防 plan-gate 误判自动放行 */
export function sanitizeForReviewGate(text: string): string {
  return (text ?? "").replace(/执行者[:：]/g, "执行方:");
}

export function obstacleAnalystEnabled(): boolean {
  const v = (process.env["OBSTACLE_ANALYST"] ?? "").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export function obstacleAnalystModel(): string {
  return process.env["OBSTACLE_ANALYST_MODEL"] ?? "bigmodel-glm-5.3-flash";
}

/** 归因提示词（系统约束 + 现场材料） */
export function buildObstacleMessages(input: {
  task: Pick<TaskRecord, "uid" | "title" | "description" | "projectRef" | "note">;
  failure: ObstacleFailure;
  siblingFailures?: Array<{ uid: string; note?: string }>;
}): Array<{ role: string; content: string }> {
  const { task, failure, siblingFailures } = input;
  const siblings = (siblingFailures ?? []).slice(0, 3).map(
    (f) => `- ${f.uid.slice(-6)}：${(f.note ?? "").slice(0, 120)}`,
  );
  return [
    {
      role: "system",
      content:
        "你是任务执行障碍分析员。分析一次 agent 任务失败的关键障碍因素与解决方法。\n" +
        "只输出纯 JSON（无 markdown 代码块）：\n" +
        '{"category":"' + OBSTACLE_CATEGORIES.join('"|"') + '",' +
        '"key_factors":["一句话一个因素"],"resolution":"可执行的解决步骤",' +
        '"prevention":"预防建议（可空）","suggested_executor":"agent|人工|运维",' +
        '"confidence":"high|medium|low"}\n' +
        "判定指引：超时/限流/配额→超时资源；模型名不存在/网关 4xx/断流→模型网关；401/403 凭证→凭证认证；" +
        "依赖缺失/构建环境→环境依赖；任务目标含糊致工人跑偏→任务描述不清；上游 API/第三方→外部服务；" +
        "工人产出本身有缺陷→代码缺陷；**任务框架自身代码/命令在既定流程中执行失败**（例：收尾器跑 " +
        "git merge-base 报 Not a valid object name、脚本自身逻辑取错引用、框架内路径拼接错）→ **工具链缺陷**；" +
        "仅当明确是仓库访问权限不足、账号无权读写、被拒绝授权时才判 权限范围——" +
        "**git 命令报任何错都不等于权限范围**，先看下方原始诊断证据再定性。\n" +
        "硬约束：① 只依据「原始诊断证据」写关键因素，证据里没有的因素不要编；" +
        "证据不足时把 confidence 置 low 或 medium 并在 key_factors 里直说「缺 X 证据」。" +
        "② **不得给出偏离处方**——不要建议「手动创建/修正远程引用」「改 remote url」「本地手动建分支」，" +
        "这些会破坏收尾流程；只给「改哪里的代码/配置 + 改完怎么验证」这类正面动作。" +
        "③ confidence 判据：有原始证据逐行佐证 → high；只有结论无证据、靠规则推断 → medium；" +
        "证据缺失只能猜 → low。**不要一律填 high**。\n" +
        "suggested_executor：修复动作可由 agent 独立完成选 agent；需人做判断/拍板选 人工；动服务器/密钥/网络选 运维。",
    },
    {
      role: "user",
      content:
        `失败任务：${task.uid}「${task.title.slice(0, 120)}」\n` +
        `归属仓库：${task.projectRef ?? "未定"}\n` +
        `任务描述：${sanitizeForReviewGate((task.description ?? "").slice(0, 1200))}\n` +
        `执行工人：${failure.member}\n` +
        `失败原文：${failure.error.slice(0, 800)}\n` +
        `台账失败备注：${sanitizeForReviewGate((task.note ?? "").slice(0, 300))}\n` +
        (failure.evidence
          ? `原始诊断证据（失败链路行级日志，定性以此为准）：\n${sanitizeForReviewGate(failure.evidence).slice(0, 1600)}\n`
          : "") +
        (siblings.length ? `同仓近期其他失败（模式识别用）：\n${siblings.join("\n")}` : ""),
    },
  ];
}

/**
 * 字符串或字符串数组归一为单段落文本。
 *
 * 2026-10-27 实测：本地 Ollama（qwen3.5）的 resolution/prevention 返回的是 **JSON 数组**
 * 而非字符串，旧实现 `String(raw["resolution"])` 会把数组糊成
 * `"检查…,确认…,若分支…"`（逗号连成一句，落卡可读性差）。这里统一为分号连接的列表文本。
 */
function asText(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map((x) => String(x ?? "").trim()).filter(Boolean).join("；");
  }
  return String(v ?? "").trim();
}

/**
 * 偏离处方过滤（审核门前置）：AI 归因里常出现「手动创建/修正远程引用」「改 remote url」
 * 「本地手动建分支」这类**会破坏收尾流程**的建议——实际事故里它们被原样写进修复卡等人照做。
 * 命中即从文本中剔除，避免误导人工执行。
 */
const DEVIANT_PRESCRIPTION_PATTERNS: RegExp[] = [
  // 「手动创建/新建/修正/添加…引用」：<任意非分隔字符> 引 用
  /手动[^，。；\n]{0,16}引用[^，。；\n]{0,16}/g,
  // 同义但无「手动」二字（如「修正代码中引用的分支名称」不在剔除范围——那是正面动作）
  /(手动|自行|人工)[^，。；\n]{0,12}(创建|新建|补上|添加)[^，。；\n]{0,12}(remote|远程|git\s*引用|refs?\/)/gi,
  // 改/检查 remote url
  /(修改|更改|检查|确认|核对)[^，。；\n]{0,12}remote\s*url[^，。；\n]{0,24}/gi,
  /(修改|更改)[^，。；\n]{0,12}(git\s*)?remote[^，。；\n]{0,24}/gi,
  // 手动创建分支 / 手动推送分支
  /手动[^，。；\n]{0,10}分支[^，。；\n]{0,24}/g,
  /git\s+update-ref[^，。；\n]{0,40}/gi,
];

export function stripDeviantPrescriptions(text: string): string {
  let out = text ?? "";
  for (const re of DEVIANT_PRESCRIPTION_PATTERNS) out = out.replace(re, "");
  // 清理残留的分隔符与空白（剔除后可能留下空条目）
  return out
    .split("；").map((s) => s.trim()).filter(Boolean).join("；")
    .replace(/^[，、；\s]+|[，、；\s]+$/g, "")
    .trim();
}

/** 解析 LLM 归因输出（容忍前后缀噪声；字段非法时逐项兜底） */
export function parseObstacleAnalysis(text: string): ObstacleAnalysis | null {
  const m = (text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as Record<string, unknown>;
    const category = OBSTACLE_CATEGORIES.includes(raw["category"] as ObstacleCategory)
      ? (raw["category"] as ObstacleCategory) : "其他";
    const factors = Array.isArray(raw["key_factors"])
      ? (raw["key_factors"] as unknown[]).map(String).filter(Boolean).slice(0, 3)
      : [];
    const resolution = stripDeviantPrescriptions(asText(raw["resolution"]));
    if (factors.length === 0 || !resolution) return null;
    const se = String(raw["suggested_executor"] ?? "人工");
    const prevention = stripDeviantPrescriptions(asText(raw["prevention"]));
    return {
      category,
      key_factors: factors,
      resolution,
      ...(prevention ? { prevention: prevention.slice(0, 200) } : {}),
      suggested_executor: se === "agent" || se === "运维" ? se : "人工",
      confidence: ["high", "medium", "low"].includes(String(raw["confidence"])) ? (String(raw["confidence"]) as ObstacleAnalysis["confidence"]) : "medium",
    };
  } catch {
    return null;
  }
}

/** LLM 不可用时的降级归因（保证修复卡仍然落账，标注降级） */
export function fallbackObstacleAnalysis(failure: ObstacleFailure): ObstacleAnalysis {
  return {
    category: "其他",
    key_factors: [failure.error.slice(0, 160) || "失败原因未回报"],
    resolution: "自动归因不可用（LLM 调用失败），请人工依据失败原文分析并补全本卡描述。",
    suggested_executor: "人工",
    confidence: "low",
  };
}

/** 组装修复卡标题与描述（描述全程经审核门净化） */
export function composeFollowUp(input: {
  failed: Pick<TaskRecord, "uid" | "title" | "projectRef">;
  failure: ObstacleFailure;
  analysis: ObstacleAnalysis;
  degraded?: boolean;
  siblingFailures?: Array<{ uid: string; note?: string }>;
}): { title: string; description: string } {
  const { failed, failure, analysis, degraded, siblingFailures } = input;
  const repoPrefix = failed.projectRef ? `[${failed.projectRef}] ` : "";
  const title = `【障碍修复】${repoPrefix}${failed.title.replace(/^【[^】]*】/g, "").slice(0, 60)}`.slice(0, 100);
  const lines: string[] = [
    `来源任务：${failed.uid}「${failed.title.slice(0, 80)}」（工人 ${failure.member} 执行失败${degraded ? "，自动归因降级" : ""}）`,
    `失败现象：${failure.error.slice(0, 300)}`,
    "",
    `障碍类别：${analysis.category}（置信度 ${analysis.confidence}）`,
    "关键因素：",
    ...analysis.key_factors.map((f) => `- ${f}`),
    `解决方法：${analysis.resolution}`,
    ...(analysis.prevention ? [`预防建议：${analysis.prevention}`] : []),
    `建议执行方：${analysis.suggested_executor}`,
  ];
  if (siblingFailures && siblingFailures.length > 0) {
    lines.push("", "同仓近期失败（同类模式参考）：");
    for (const f of siblingFailures.slice(0, 3)) lines.push(`- ${f.uid.slice(-6)}：${(f.note ?? "").slice(0, 100)}`);
  }
  lines.push(
    "",
    "人工审核后进入下一轮派发：",
    "· 人工路径：群里回复「安排执行者 编号 @姓名」（将自动建工单进 D）",
    "· agent 路径：把本卡标题改为【agent】开头（免工单，工人小组直接认领）",
  );
  return { title, description: sanitizeForReviewGate(lines.join("\n")) };
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * 归因主流程：幂等检查 → LLM 分析 → 失败任务 note 追加摘要 →（有建卡器时）
 * 组装修复卡文案并建卡 → 台账落修复任务（origin=卡 guid，与 plan-gate 合流）。
 * 幂等：同失败任务存在非终态修复卡（links.obstacle-source 命中）→ 跳过建卡。
 * createCard 返回 undefined = 建卡失败 → 只归因不落修复任务（note 仍已更新）。
 */
export async function runObstacleAnalyst(opts: {
  registry: TaskRegistry;
  failedUid: string;
  failure: ObstacleFailure;
  /** 建卡器：拿分析后的标题/描述去建飞书卡（不注入则只归因，不落修复任务） */
  createCard?: (follow: { title: string; description: string }) => Promise<{ guid: string; url?: string } | undefined>;
  llm: ObstacleLlm;
  model?: string;
  siblingFailures?: Array<{ uid: string; note?: string }>;
}): Promise<Result<{ uid?: string; analysis: ObstacleAnalysis; degraded?: boolean; skipped?: string }>> {
  const { registry, failedUid, failure, llm } = opts;
  const failed = registry.get(failedUid);
  if (!failed) return err(`obstacle-analyst: 未知失败任务 ${failedUid}`);

  // 幂等防噪：同失败任务已有非终态修复卡 → 不重复建卡（note 也不重复追加）
  const existing = registry.findByExternal("obstacle-source", failedUid);
  if (existing && !TERMINAL.has(existing.status)) {
    return ok({ uid: existing.uid, analysis: {
      category: "其他", key_factors: ["已有待审核修复卡"], resolution: "沿用既有修复卡",
      suggested_executor: "人工", confidence: "high",
    }, skipped: "已有非终态修复卡" });
  }

  // 归因（LLM 失败 → 降级，不中断落账）
  let analysis: ObstacleAnalysis;
  let degraded = false;
  try {
    const r = await llm({
      model: opts.model ?? obstacleAnalystModel(),
      messages: buildObstacleMessages({ task: failed, failure, siblingFailures: opts.siblingFailures }),
      temperature: 0.2,
      max_tokens: 600,
    });
    const parsed = r.ok && r.value?.text ? parseObstacleAnalysis(r.value.text) : null;
    analysis = parsed ?? fallbackObstacleAnalysis(failure);
    degraded = parsed === null;
  } catch {
    analysis = fallbackObstacleAnalysis(failure);
    degraded = true;
  }

  // 失败任务 note 追加归因摘要（保留原 note 现场信息）
  const summaryTag = `障碍分析：${analysis.category} → ${analysis.resolution.slice(0, 80)}`;
  const mergedNote = `${(failed.note ?? "").slice(0, 160)} | ${summaryTag}`.slice(0, 300);
  registry.update(failedUid, { note: mergedNote });

  // 建卡 → 台账落修复任务（无建卡器 = 纯归因模式，仅 note）
  if (!opts.createCard) return ok({ analysis, degraded });
  const follow = composeFollowUp({ failed, failure, analysis, degraded, siblingFailures: opts.siblingFailures });
  let card: { guid: string; url?: string } | undefined;
  try {
    card = await opts.createCard(follow);
  } catch (e) {
    console.error(`[obstacle-analyst] 建卡失败（只归因不落修复任务）: ${String(e)}`);
    return ok({ analysis, degraded });
  }
  if (!card) return ok({ analysis, degraded });
  const rec = registry.adopt({
    title: follow.title,
    description: follow.description,
    status: "planned",
    origin: { provider: "feishu-task", guid: card.guid, ...(card.url ? { url: card.url } : {}) },
    ...(failed.projectRef ? { projectRef: failed.projectRef } : {}),
    related: { "obstacle-source": { guid: failedUid } },
  });
  return ok({ uid: rec.uid, analysis, degraded, ...(card.url ? {} : {}) });
}
