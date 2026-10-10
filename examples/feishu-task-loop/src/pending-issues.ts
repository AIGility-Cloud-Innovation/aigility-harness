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
  return (r.description ?? "").match(/执行者：(\S+)/)?.[1];
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
 */
export function computePendingBuckets(registry: {
  list: (q: { status: UnifiedStatus[] }) => TaskRecord[];
}): PendingBuckets {
  const planned = registry.list({ status: ["planned"] as UnifiedStatus[] });
  const missingExecutor = planned.filter((t) => {
    const desc = t.description ?? "";
    if (/执行者[:：]\s*\S+/.test(desc)) return false; // 描述已定（含「执行者：agent」）
    return !executorOfTask({ members: (t as { members?: unknown[] }).members as never, description: desc });
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
  const execUids = new Set(missingExecutor.map((t) => t.uid));
  const projUids = new Set(missingProject.map((t) => t.uid));

  const tagOf = (uid: string): string => {
    const tags: string[] = [];
    if (execUids.has(uid)) tags.push("缺执行人");
    if (projUids.has(uid)) tags.push("缺归属");
    return tags.length ? `（${tags.join("、")}）` : "";
  };

  const all = planned.map((r) => `${codeOfUid(codes, r.uid)}｜${r.title.slice(0, 36)}${tagOf(r.uid)}`);
  const wantAll = pageSpec && /^(全部|all)$/i.test(pageSpec.trim());
  const pageNum = wantAll ? 1 : Math.max(1, Number(pageSpec ?? "1") || 1);
  const pages = Math.max(1, Math.ceil(all.length / PENDING_PAGE_SIZE));
  const slice = wantAll ? all : all.slice((pageNum - 1) * PENDING_PAGE_SIZE, pageNum * PENDING_PAGE_SIZE);
  const header = `📌 有 ${total} 条任务等你处理（缺执行人 ${missingExecutor.length}、缺归属 ${missingProject.length}）：`;
  const lines = slice.map((l) => `  - ${l}`);
  const footer = wantAll
    ? `（共 ${total} 条 · 回复短码直接补要素，如「R01 执行人 张三 归属 opc」；「R01 执行人 agent」= 让编码代理做）`
    : `（第 ${Math.min(pageNum, pages)}/${pages} 页 · 共 ${total} 条 · 「复核清单 ${Math.min(pageNum + 1, pages)}」看下页 /「复核清单 全部」一次看全；回复短码直接补要素）`;
  return [header, ...lines, footer].join("\n");
}
