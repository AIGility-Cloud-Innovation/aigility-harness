/** 抓取 2026-10-01 至今各成员记忆, 带本地时间戳输出 JSON */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { TimemClient } from "@timem/dsh-plugin-timem";

const root = "/home/johnny/AI/aigility-harness";
for (const p of [`${root}/.env`, `${root}/examples/.dsh-home/.env`]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim(); const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
  }
}

const reg = JSON.parse(readFileSync(`${root}/config/timem-team-registry.json`, "utf8"));
const client = new TimemClient({ apiKey: process.env.TIMEM_API_KEY!, baseUrl: process.env.TIMEM_BASE_URL });

const QUERIES = [
  "最近 工作 进展 项目", "计划 问题 部署 完成", "讨论 决定 方案 需求",
  "修复 测试 bug 上线", "任务 看板 工单", "会议 沟通 安排",
  "完成 提交 代码", "遇到 问题 阻塞", "架构 设计 文档",
];

const out: Record<string, { name: string; items: any[] }> = {};
for (const m of reg.members) {
  if (!m.timem_user_ids?.length) continue;
  const found = new Map<string, any>();
  for (const uid of m.timem_user_ids) {
    for (const q of QUERIES) {
      try {
        const res = await client.searchMemory({ user_id: uid, query: q, limit: 30, level: 2 });
        const items = res.memories ?? res.results ?? res.items ?? [];
        for (const it of items) {
          const id = String((it as any).id ?? it.memory_id ?? "");
          if (!id || found.has(id)) continue;
          const created = it.created_at ?? (it as any).time_window_start ?? "";
          found.set(id, { id, created_at: created, content: it.content });
        }
      } catch (e) { console.error(`${m.name} ${uid} "${q}": ${(e as Error).message}`); }
    }
  }
  const items = [...found.values()].filter((it) => it.created_at >= "2026-10-01");
  items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  out[m.member_id] = { name: m.name, items };
  console.error(`${m.name}: ${items.length} 条 (10-01 之后)`);
}
writeFileSync("/tmp/timem-range.json", JSON.stringify(out, null, 2));
console.log("done");
