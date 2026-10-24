/**
 * pending-issues — 「待处理任务」单一事实源（复核清单 / 定时提醒共用构建器）
 *
 * 2026-10-10 合并（负责人反馈：复核清单每次都只出同 10 条、和提醒的
 * 「📌 有 43 条任务等你处理」对不上）：此前两条工作流各算各的——
 *   · 复核清单（review-aware）：planned 前 10 条固定截断，无统计无翻页；
 *   · 提醒（review-reminder）：按缺执行人/缺归属两类统计，各取前 5 条私信。
 * 统一后：
 *   · 缺执行人/缺归属的判定只此一份（与执行人闸门同源：负责人字段优先、描述标记兜底）；
 *   · 行格式统一（短码｜PDCA 截面｜仓库｜标题｜执行人｜缺什么）；
 *   · 复核清单支持翻页（「复核清单 2」「复核清单 全部」），头部统计与提醒一致。
 *
 * 模块依赖方向：review-aware / review-reminder → 本模块 →（layer-orchestration,
 * board-sync）；本模块不 import review-aware（registry/codes 由调用方传入），
 * 避免循环依赖。
 */
import {
  getIdentityRegistry,
  identityMembers,
  executorOfTask,
} from "@aigility-harness/layer-orchestration";
import type { TaskRecord } from "@aigility-harness/core";
import type { UnifiedStatus } from "@aigility-harness/core";
import { getProjectedSection } from "./board-sync.js";
/** 台账状态 → PDCA 看板语言 */
const PDCA_OF: Record<string, string> = {
  planned: "P·规划中",
  ready: "P·已放行",
  dispatched: "D·执行中",
  running: "D·执行中",
  review: "C·待测试",
  failed: "A·待修复",
  blocked: "blocked",
  cancelled: "已取消",
  done: "已完成",
};

/** 执行人解析：结构化外键优先（人员台账反查姓名），历史描述文本兜底 */
export function executorNameOf(r: { assignee_member_id?: string; description?: string }): string | undefined {
  if (r.assignee_member_id) {
    const m = identityMembers(getIdentityRegistry()).find((x) => x.member_id === r.assignee_member_id);
    if (m) return m.name;
  }
  const marked = (r.description ?? "").match(/执行者：(\S+)/)?.[1];
  return marked && /^agent/i.test(marked) ? undefined : marked; // agent/agentd 非人名（2026-10-20）
}

/** uid → 短码（码表里没有返回 —） */
export function codeOfUid(codes: Record<string, string>, uid: string): string {
  return Object.entries(codes).find(([, u]) => u === uid)?.[0] ?? "—";
}

/** 待处理行格式（复核清单 / 提醒共用） */
export function pendingTaskLine(
  code: string,
  r: Pick<TaskRecord, "uid" | "status" | "title" | "projectRef" | "description" | "assignee_member_id">,
): string {
  // PDCA 以看板实际截面为优先（人工挪组已反向同步），无截面记录时回退台账状态
  const sec = getProjectedSection(r.uid);
  const pdca =
    (sec && ({ P: "P·规划中", D: "D·执行中", C: "C·待测试", A: "A·待修复" } as Record<string, string>)[sec]) ||
    PDCA_OF[r.status] ||
    r.status;
  const repo = r.projectRef ?? "（未定仓库）";
  const title = r.title
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^【[^】]+】/, "")
    .slice(0, 36);
  const executor = executorNameOf(r);
  return `  - ${code}［${pdca}｜${repo}］${title}${executor ? ` · 执行人 ${executor}` : ""}`;
}

export interface PendingBuckets {
  /** 缺执行人（负责人/描述标记/「执行者：agent」皆无） */
  missingExecutor: TaskRecord[];
  /** 缺归属（projectRef 为空） */
  missingProject: TaskRecord[];
}

/**
 * 待处理分桶（两清单共用的唯一口径；与 review-reminder 2026-10-10 拍板一致：
 * ready/dispatched/running 是正常执行态非待办，只看 planned）。
 * 同一条任务可同时缺执行人和缺归属（进两个桶，两处列表都会出现）。
 *
 * 2026-10-24 口径修复（用户反馈三类误收）：
 * ① 挂起判定：标题含「挂起」（不限【】包裹）**或**看板投影段位为「挂」——
 *    人挪挂起段位时标题不变，只认标题会漏（R66/数据表格案例）；
 * ② agent 认定：标题任意位置【agent】或描述「执行者：agent」皆算已安排
 *    （原只认标题开头，前缀挪位/描述标记全漏，与 plan-gate 口径对齐）；
 * ③ 真人 assignee：executorOfTask 链路本身不误收——健康卡（有执行人+有归属）
 *    只出现在「复核清单 全部」全量视图，默认页只列缺要素卡（口径本就如此，补测试锁住）。
 * sectionLookup 参数供测试注入投影（默认真实 getProjectedSection）。
 */
export function computePendingBuckets(
  registry: { list: (q: { status: UnifiedStatus[] }) => TaskRecord[] },
  sectionLookup: (uid: string) => string | undefined = getProjectedSection,
): PendingBuckets {
  const planned = registry.list({ status: ["planned"] as UnifiedStatus[] });
  // 挂起 = 车主明确停进 garage 的卡（2026-10-23 口径，2026-10-24 扩段位投影）：
  // 标题含「挂起」（【挂起】/「挂起xxx」等变体）或看板段位投影为「挂」，
  // 不算缺要素待办，否则挂起任务永远挂在清单里刷存在感。
  const parked = (t: TaskRecord) =>
    (t.title ?? "").includes("挂起") || sectionLookup(t.uid) === "挂";
  const missingExecutor = planned.filter((t) => {
    if (parked(t)) return false;
    const desc = t.description ?? "";
    const title = t.title ?? "";
    // agent 任务不需要人类执行人 → 不进缺执行人桶（2026-10-24：标题任意位置
    // 【agent】或描述「执行者：agent」皆认定，不再锚定标题开头）
    if (/【agent】/.test(title)) return false;
    if (/^agent/i.test(desc.match(/执行[者人][:：]\s*(\S+)/)?.[1] ?? "")) return false;
    // 判定源与执行人闸门同源（executorOfTask）：members 负责人 / assignee_member_id
    // （①.2 反向同步落库）/ 描述人名标记，任一有 = 不缺；agent 值不算执行人（2026-10-20）
    return !executorOfTask({
      members: (t as { members?: unknown[] }).members as never,
      description: desc,
      assignee_member_id: t.assignee_member_id,
    });
  });
  const missingProject = planned.filter((t) => !t.projectRef);
  return { missingExecutor, missingProject };
}

/** 每页条数（「复核清单」默认页大小） */
export const PENDING_PAGE_SIZE = 10;

/**
 * 复核清单全量报告（分页）。
 * @param pageSpec undefined=第 1 页；"2"=第 2 页；"全部"/"all"=全量
 */
export function buildPendingIssuesReport(
  registry: { list: (q: { status: UnifiedStatus[] }) => TaskRecord[] },
  codes: Record<string, string>,
  pageSpec?: string,
): string {
  const planned = registry.list({ status: ["planned"] as UnifiedStatus[] });
  if (!planned.length) return "当前没有待复核的任务，都清了 🎉";
  const { missingExecutor, missingProject } = computePendingBuckets(registry);
  const total = planned.length;
  // 统计口径对齐（2026-10-23 用户反馈：手动复核清单 48 vs 自动播报 19）——
  // 「等你处理」= 缺要素并集（缺执行人∪缺归属∪缺仓库），与定时提醒同口径；
  // 非 planned 不算，挂起不算，已派发未完卡不算。total 只作页脚全量参考。
  const bucketUids = new Set([...missingExecutor, ...missingProject].map((t) => t.uid));
  const awaiting = bucketUids.size;
  const execUids = new Set(missingExecutor.map((t) => t.uid));
  const projUids = new Set(missingProject.map((t) => t.uid));

  const tagOf = (uid: string): string => {
    const tags: string[] = [];
    if (execUids.has(uid)) tags.push("缺执行人");
    if (projUids.has(uid)) tags.push("缺归属");
    return tags.length ? `（${tags.join("、")}）` : "";
  };

  // 默认列「等你处理」的卡（与头部统计同口径）；「复核清单 全部」= 板面规划全量
  const wantAll = pageSpec && /^(全部|all)$/i.test(pageSpec.trim());
  if (!wantAll && awaiting === 0) {
    return `当前没有等你处理的任务（缺要素已清）🎉 板面规划尚有 ${total} 条（已就绪/挂起等非待办态）。看全量发「复核清单 全部」。`;
  }
  const listing = (wantAll ? planned : planned.filter((r) => bucketUids.has(r.uid))).map(
    (r) => `${codeOfUid(codes, r.uid)}｜${r.title.slice(0, 36)}${tagOf(r.uid)}`,
  );
  const pageNum = wantAll ? 1 : Math.max(1, Number(pageSpec ?? "1") || 1);
  const pages = Math.max(1, Math.ceil(listing.length / PENDING_PAGE_SIZE));
  const slice = wantAll ? listing : listing.slice((pageNum - 1) * PENDING_PAGE_SIZE, pageNum * PENDING_PAGE_SIZE);
  const header = `📌 等你处理 ${awaiting} 条（缺执行人 ${missingExecutor.length}、缺归属 ${missingProject.length}）；板面规划全量 ${total} 条（含已就绪/挂起）。`;
  const lines = slice.map((l) => `  - ${l}`);
  const footer = wantAll
    ? `（板面规划全量 ${total} 条 · 回复短码直接补要素，如「R01 执行人 张三 归属 opc」；「R01 执行人 agent」= 让编码代理做）`
    : `（第 ${Math.min(pageNum, pages)}/${pages} 页 · 等你处理 ${awaiting} 条 · 「复核清单 全部」看板面全量 ${total}；回复短码直接补要素）`;
  return [header, ...lines, footer].join("\n");
}
