/** 调试: 查看记忆搜索原始返回字段 (用后即删) */
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
console.log("key prefix:", process.env.TIMEM_API_KEY?.slice(0, 8), "base:", process.env.TIMEM_BASE_URL);
const r = await c.searchMemory({ user_id: "space_1aa2ac52-9b07-4b87-b946-008cb40b54c4", query: "工作 进展", limit: 3 });
const items = r.memories ?? r.results ?? [];
console.log(JSON.stringify(items[0], null, 1).slice(0, 900));
console.log("keys:", items[0] ? Object.keys(items[0]).join(",") : "none");
