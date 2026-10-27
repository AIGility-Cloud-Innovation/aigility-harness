/**
 * 把 README 验证任务（a560ab62）的台账推进到 ready（用户 2026-10-27 指示）。
 *
 * 背景：用户已手动把卡挪进 D 组（= 授权派发）。
 *   但台账停在 candidate，状态机不允许 candidate → ready，
 *   必须先 candidate → planned → ready（approve 是 planned→ready 的唯一入口）。
 *
 * 与 Q1 修复的关系：handlePendingConfirm 的推进步补上后，正常链路
 *   「确认 R编号」→ candidate → planned 会自动完成；
 *   本脚本是针对已存在的这条卡一次性补齐（它的 P 组扫描早于修复生效）。
 */
import { TaskRegistry } from "../packages/layer-orchestration/dist/task-registry.js";

const REG = "/home/johnny/AI/aigility-harness/config/task-registry.local.json";
const UID = "tsk_57ca0620-ab13-4a8b-94d0-eaf5253765d2";

const reg = new TaskRegistry(REG);
reg.recover(); // 从磁盘加载既有记录（构造只设路径，不读文件）
const rec = reg.get(UID);
if (!rec) throw new Error(`未找到台账 ${UID}`);
console.log(`起始状态: ${rec.status}`);

if (rec.status === "ready") {
  console.log("⏭ 已是 ready，无需推进");
} else {
  if (rec.status !== "planned") {
    const p = reg.transition(UID, "planned", "candidate");
    console.log(p.ok ? `✅ ${rec.status} → planned` : `❌ → planned 失败: ${p.error}`);
    if (!p.ok) process.exit(1);
  }
  const a = reg.approve(UID, {
    via: "manual",
    by: "user",
    note: "用户手动挪 D 授权派发（2026-10-27）；candidate→planned→ready 补齐",
  });
  console.log(a.ok ? "✅ planned → ready（已放行）" : `❌ approve 失败: ${a.error}`);
  if (!a.ok) process.exit(1);
}

reg.flushSync();
const after = reg.get(UID);
console.log(`\n最终状态: ${after?.status}`);
console.log(`review: ${JSON.stringify(after?.review)}`);