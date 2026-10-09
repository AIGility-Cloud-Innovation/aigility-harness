/**
 * 三方盘点（只读）v2：飞书任务清单（P/D/C/A 分组）+ Gitea 工单 + 本地任务台账
 * 端点形状按仓内 feishu-task-provider/task-issue-sync 已验证路径。
 * 用法: npx tsx scripts/task-audit.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/johnny/AI/aigility-harness";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] ??= v;
  return env;
}
const ENV = loadEnv();

const tokenStore = JSON.parse(readFileSync(join(ROOT, "config/feishu/user_token.local.json"), "utf8"));
const userToken = tokenStore.access_token ?? tokenStore.token;
const FEISHU_BASE = "https://open.feishu.cn/open-apis";

async function feishu(path: string, query: Record<string, string | number | boolean> = {}) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const url = FEISHU_BASE + path + (qs ? `?${qs}` : "");
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${userToken}`, "Content-Type": "application/json" } });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`feishu ${path}: 非 JSON(HTTP ${res.status}): ${text.slice(0, 100)}`); }
  if (j.code !== 0) throw new Error(`feishu ${path}: ${j.code} ${j.msg}`);
  return j.data;
}

const giteaToken = readFileSync(join(process.env.HOME ?? "/home/johnny", ".gitea-token"), "utf8").trim();
const GITEA = "https://git.aigility.cloud/api/v1";
async function gitea(path: string) {
  const res = await fetch(GITEA + path, { headers: { "Authorization": `token ${giteaToken}` } });
  const text = await res.text();
  if (text.startsWith("<")) throw new Error(`gitea ${path}: HTML(HTTP ${res.status})`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  const out: any = { fetchedAt: new Date().toISOString(), tasklists: [], issues: [], localTasks: [] };

  // ① 飞书：清单 → 分组 → 组内任务（直接带 summary）+ 未分组任务
  const lists = await feishu("/task/v2/tasklists", { page_size: 50, user_id_type: "open_id" });
  for (const l of (lists.items ?? [])) {
    if (!l.guid) continue;
    const sections = await feishu(`/task/v2/sections`, { resource_type: "tasklist", resource_id: l.guid, page_size: 50, user_id_type: "open_id" }).catch(() => ({ items: [] }));
    const tasks: any[] = [];
    const seen = new Set<string>();
    for (const sec of (sections.items ?? [])) {
      if (!sec.guid) continue;
      const st = await feishu(`/task/v2/sections/${sec.guid}/tasks`, { completed: false, page_size: 100, user_id_type: "open_id" }).catch(() => ({ items: [] }));
      for (const t of (st.items ?? [])) {
        const g = t.guid ?? t.task_id;
        if (!g || seen.has(g)) continue;
        seen.add(g);
        tasks.push({ guid: g, summary: t.summary ?? "(无标题)", section: sec.name ?? "(未命名组)" });
      }
    }
    const lt = await feishu(`/task/v2/tasklists/${l.guid}/tasks`, { completed: false, page_size: 100, user_id_type: "open_id" }).catch(() => ({ items: [] }));
    for (const t of (lt.items ?? [])) {
      const g = t.guid ?? t.task_id;
      if (!g || seen.has(g)) continue;
      seen.add(g);
      tasks.push({ guid: g, summary: t.summary ?? "(无标题)", section: "(无分组)" });
    }
    if (tasks.length) out.tasklists.push({ name: l.name, guid: l.guid, tasks });
  }

  // ② Gitea：org 仓库 + open 工单
  const repos: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gitea(`/repos/search?limit=50&page=${page}`) as any;
    const data = Array.isArray(batch) ? batch : batch.data ?? [];
    repos.push(...data.filter((r: any) => r.full_name?.startsWith("AIGility-Cloud-Innovation/")).map((r: any) => r.full_name));
    if (data.length < 50) break;
  }
  for (const repo of repos) {
    const issues = await gitea(`/repos/${repo}/issues?state=open&limit=50&type=issues`).catch(() => []);
    for (const i of issues as any[]) {
      out.issues.push({ repo, number: i.number, title: i.title, labels: (i.labels ?? []).map((x: any) => x.name), updatedAt: i.updated_at });
    }
  }

  // ③ 本地任务台账
  const reg = JSON.parse(readFileSync(join(ROOT, "config/task-registry.local.json"), "utf8"));
  out.localTasks = (reg.tasks ?? []).map((t: any) => ({
    uid: t.uid, title: t.title, status: t.status, projectRef: t.projectRef,
    feishuGuid: t.links?.["feishu-task"]?.guid ?? t.origin?.guid, updatedAt: t.updatedAt,
  }));

  mkdirSync("/home/johnny/.hermes/cache/scratch", { recursive: true });
  writeFileSync("/home/johnny/.hermes/cache/scratch/task-audit.json", JSON.stringify(out, null, 1));
  console.log("飞书清单:", out.tasklists.map((l: any) => `${l.name}(${l.tasks.length})`).join(" "));
  console.log("Gitea 仓库:", repos.length, "| open 工单:", out.issues.length);
  console.log("本地台账:", out.localTasks.length);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
