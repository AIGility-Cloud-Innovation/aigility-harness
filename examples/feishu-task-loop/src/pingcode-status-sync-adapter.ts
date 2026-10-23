/**
 * pingcode-status-sync（loop 侧适配器）— 台账+板面投影 → 快照 → 触发联动。
 *
 * 快照源（每拍 ①.5 看板反向对齐刚跑完，两者都是最新）：
 *   · 分组：config/board-projection.local.json（uid → P/D/C/A/挂，syncBoardAlignment 维护）
 *   · 完成：台账 status=done → completed=true → PC 关闭
 *   · 投影里没有且台账非 done 的映射卡：跳过不猜（挂起组在投影里是「挂」→ 模块侧不联动）
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskRegistry } from "@aigility-harness/layer-orchestration";
import { syncPingcodeStatuses } from "./pingcode-status-sync.js";

const LOOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROJECTION_FILE = join(LOOP_ROOT, "config", "board-projection.local.json");

function loadProjection(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(PROJECTION_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 台账+投影 → 快照：只含能确定状态的卡（投影缺失且未完成 → 跳过不猜）。 */
export function buildSnapshotFromRegistry(registry: TaskRegistry): Map<string, { section: string; completed: boolean }> {
  const snap = new Map<string, { section: string; completed: boolean }>();
  const projection = loadProjection();
  for (const t of registry.list()) {
    const guid = t.links?.["feishu-task"]?.guid ?? (t.origin?.provider === "feishu-task" ? t.origin?.guid : undefined);
    if (!guid) continue;
    const done = t.status === "done";
    const key = projection[t.uid];
    if (!key) {
      if (done) snap.set(guid, { section: "", completed: true }); // 完成卡可能已出投影：仍要关闭
      continue; // 其余无投影：不猜
    }
    snap.set(guid, { section: key, completed: done });
  }
  return snap;
}

/** 每拍入口（onReport ①.56 调用）：返回变更描述。 */
export async function runPingcodeStatusSync(
  registry: TaskRegistry,
  notify?: (text: string) => void | Promise<void>,
): Promise<string[]> {
  return syncPingcodeStatuses({ snapshot: buildSnapshotFromRegistry(registry), repoRoot: resolve(LOOP_ROOT), notify });
}
