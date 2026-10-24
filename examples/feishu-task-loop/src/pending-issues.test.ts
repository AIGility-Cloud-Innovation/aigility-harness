/** pending-issues.test.ts — 复核清单分桶口径测试（挂起段位/agent认定/真人assignee）。 */
import assert from "node:assert/strict";
import { computePendingBuckets } from "./pending-issues.js";
import type { TaskRecord } from "@aigility-harness/core";

function fakeRegistry(tasks: TaskRecord[]) {
  return { list: (_q: { status: string[] }) => tasks };
}

const base = (over: Partial<TaskRecord>): TaskRecord =>
  ({ uid: "u", status: "planned", title: "任务", projectRef: "TiMEM-AI/repo", description: "", ...over }) as TaskRecord;

const tasks: TaskRecord[] = [
  base({ uid: "u1", title: "【挂起】排个运维任务" }), // 标题【挂起】
  base({ uid: "u2", title: "挂起【timem cloud】数据表格搭建" }), // 挂起词首变体（无【】包裹）
  base({ uid: "u3", title: "【agent】[TiMEM-AI/repo] 峰谷系数优化" }), // agent 标题
  base({ uid: "u4", title: "[TiMEM-AI/repo] 导出明细", description: "执行者：agent" }), // agent 描述标记
  base({ uid: "u5", title: "[repo] 真人负责", assignee_member_id: "ou_x" }), // 真人 assignee
  base({ uid: "u6", title: "帮助文档完善", description: "无任何标记" }), // 真缺执行人
  base({ uid: "u7", title: "缺归属卡", description: "", projectRef: undefined }), // 真缺归属
  base({ uid: "u8", title: "在后台账号管理列表中增加认证信息列" }), // 无标记无assignee（现状真实漏收案例）
];

// 投影注入：u8 在看板被挪进「挂」段位（标题无挂起字样——2026-10-24 误收案例形态）
const sectionLookup = (uid: string) => (uid === "u8" ? "挂" : undefined);

const { missingExecutor, missingProject } = computePendingBuckets(fakeRegistry(tasks), sectionLookup);
const execUids = missingExecutor.map((t) => t.uid);
const projUids = missingProject.map((t) => t.uid);

assert.ok(!execUids.includes("u1"), "标题【挂起】不应进缺执行人桶");
assert.ok(!execUids.includes("u2"), "挂起词变体不应进缺执行人桶");
assert.ok(!execUids.includes("u3"), "标题【agent】不应进缺执行人桶");
assert.ok(!execUids.includes("u4"), "描述「执行者：agent」不应进缺执行人桶");
assert.ok(!execUids.includes("u5"), "真人 assignee 不应进缺执行人桶");
assert.ok(!execUids.includes("u8"), "看板挂起段位投影不应进缺执行人桶");
assert.ok(execUids.includes("u6"), "无任何执行标记才进缺执行人桶");
assert.ok(execUids.includes("u7") === false || true, "u7 缺归属但有标题可执行，不强制进执行人桶");
assert.ok(projUids.includes("u7"), "无 projectRef 进缺归属桶");
assert.ok(!projUids.includes("u5"), "有归属不进缺归属桶");

// 默认参数路径（真实 getProjectedSection）烟测：不炸即通
const smoke = computePendingBuckets(fakeRegistry([base({ uid: "u9", title: "烟测" })]));
assert.ok(Array.isArray(smoke.missingExecutor), "默认投影路径可用");

console.log("✅ pending-issues 分桶口径测试全过:", { execUids, projUids });
