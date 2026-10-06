/**
 * review-session.ts — 复核台账只读查询
 *
 * 2026-10-04 起收集/确认全部归机器人进程（写者唯一，消灭双写覆盖）：
 *   · 复核清单与短码：对齐器每 10 分钟自动收集续号，群里发「复核清单」可查；
 *   · 确认/放行：群里直接自然回复（「R01 执行人 xx 归属 xx」/「确认 R01」）。
 * 本脚本仅打印台账概览与最近审计，不做任何写入。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskRegistry } from "@aigility-harness/layer-orchestration";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REGISTRY_FILE = join(ROOT, "config/task-registry.local.json");
const SESSION_FILE = join(ROOT, "config/review-session.local.json");
const AUDIT_FILE = join(ROOT, "config/review-audit.local.jsonl");

if (!existsSync(REGISTRY_FILE)) {
  console.log("台账尚未创建（机器人首次对齐后生成）：", REGISTRY_FILE);
  process.exit(0);
}
const registry = new TaskRegistry(REGISTRY_FILE);
registry.recover();
const codes = existsSync(SESSION_FILE)
  ? (JSON.parse(readFileSync(SESSION_FILE, "utf-8")) as Record<string, string>)
  : {};

const byCode = Object.entries(codes).map(([code, uid]) => ({ code, record: registry.get(uid) }));
console.log(`短码会话：${byCode.length} 条`);
for (const { code, record } of byCode) {
  if (!record) {
    console.log(`  ${code}（台账中已不存在）`);
    continue;
  }
  console.log(`  ${code} [${record.status}] ${record.title.slice(0, 36)}${record.projectRef ? ` @${record.projectRef}` : ""}${record.review ? `  复核:${record.review.via}/${record.review.by}` : ""}`);
}
const counts = registry.list().reduce<Record<string, number>>((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
console.log(`\n登记表全量 ${registry.list().length} 条：`, JSON.stringify(counts));
if (existsSync(AUDIT_FILE)) {
  const tail = readFileSync(AUDIT_FILE, "utf-8").trimEnd().split("\n").slice(-5);
  console.log("\n最近审计：");
  for (const line of tail) console.log(`  ${line}`);
}
