/** 调试: 不带 user_id 搜索, 查看能否发现未登记账号的痕迹 (用后即删) */
import { TimemClient } from "@timem/dsh-plugin-timem";
import { readFileSync, existsSync } from "node:fs";

for (const p of ["../../.env", "../../examples/.dsh-home/.env"]) {
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = l.trim();
    const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
  }
}

const c = new TimemClient({ apiKey: process.env.TIMEM_API_KEY!, baseUrl: process.env.TIMEM_BASE_URL });
const r = await c.searchMemory({ query: "今天 工作 进展 问题", limit: 15 });
const items = r.memories ?? r.results ?? [];
console.log("count:", items.length);
for (const it of items.slice(0, 12)) {
  const m = (it.metadata ?? {}) as Record<string, unknown>;
  console.log(
    "-",
    (it.content ?? "").slice(0, 60).replace(/\s+/g, " "),
    "| agent:", it.agent_id ?? m.agent ?? "-",
    "| subject:", JSON.stringify(m.subject ?? it.domain ?? "-"),
    "| session:", m.root_session_id ?? m.segment_id ?? "-",
  );
}
