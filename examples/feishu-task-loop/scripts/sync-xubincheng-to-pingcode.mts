/**
 * 一次性同步：飞书任务清单中「徐彬程」名下的任务 → PingCode 建工单（2026-10-21）。
 * 规则：
 *  - 扫 FEISHU_TASKLIST_NAME（缺省 AIGility-Cloud-Innovation、TiMEM-AI）全部未完成任务；
 *  - assignee（members role=assignee）解析为徐彬程（open_id ou_a7fbf870…）的卡才是目标；
 *  - 标题已带 [org/repo#N]（双建过）或描述已含 aici.pingcode.com 链接的卡跳过（已同步）;
 *  - org→PingCode 项目映射硬编码（错了宁可不建）：TiMEM-AI→TYY, AIGility-Cloud-Innovation→TAI；
 *  - 建单 body 最小化（project_id/subject/description），失败打印上游原文并停止，不猜字段；
 *  - 每条建完 GET 回读，whole_identifier 打进报告。
 * 用法: cd /home/johnny/AI/aigility-harness && npx tsx examples/feishu-task-loop/scripts/sync-xubincheng-to-pingcode.mts [--apply]
 *      缺省 dry-run（只报告不建单）；--apply 才真正创建。
 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const APPLY = process.argv.includes("--apply");
const XSBC_OPEN_ID = "ou_a7fbf870dc5f8f6004f21ee3ef8fed1a";
const ORG2PROJECT: Record<string, string> = {
  "TiMEM-AI": "TYY",
  "AIGility-Cloud-Innovation": "TAI",
};
/** 建单 type_id：用户拍板用通用「任务」而非「特性」（2026-10-21；类型枚举 /workitem_types?project_id= 实测） */
const WORKITEM_TYPE_ID = "6628f44becf3cef770511507";

// ── 飞书侧：拉全部任务 ─────────────────────────────────────────
const fsTok = await getFreshUserToken(readTokenEnv());
const FH = { Authorization: `Bearer ${fsTok}` };
async function fsGet(path: string, query: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`https://open.feishu.cn${path}?${qs}`, { headers: FH });
  return (await r.json()) as any;
}

const listNames = (process.env.FEISHU_TASKLIST_NAME ?? "AIGility-Cloud-Innovation,TiMEM-AI").split(",").map((s) => s.trim());
const candidates: Array<{ name: string; tasklist: string; guid: string; description: string; url: string; org?: string; repo?: string }> = [];
for (const listName of listNames) {
  const lists = await fsGet("/open-apis/task/v2/tasklists", { page_size: 50, user_id_type: "open_id" });
  const list = (lists?.data?.items ?? []).find((l: any) => l.name === listName);
  if (!list) {
    console.log(`⚠️ 找不到任务清单「${listName}」，跳过`);
    continue;
  }
  let token: string | undefined;
  do {
    const d = await fsGet(`/open-apis/task/v2/tasklists/${list.guid}/tasks`, {
      page_size: 100, user_id_type: "open_id", ...(token ? { page_token: token } : {}),
    });
    for (const t of d?.data?.items ?? []) {
      if (t.completed_at && Number(t.completed_at) !== 0) continue;
      const assignee = (t.members ?? []).find((m: any) => m.role === "assignee")?.id;
      if (assignee !== XSBC_OPEN_ID) continue;
      const summary: string = t.summary ?? "";
      const dm = summary.match(/\[([^\]#/]+)\/([^\]#/]+)(?:#(\d+))?\]/);
      const desc: string = t.description ?? "";
      const alreadyPing = /aici\.pingcode\.com/.test(desc) || (dm?.[3] !== undefined);
      if (alreadyPing) continue;
      candidates.push({
        name: summary, tasklist: listName, guid: t.guid ?? t.task_id,
        description: desc, url: t.url ?? "", org: dm?.[1], repo: dm?.[2],
      });
    }
    token = d?.data?.page_token;
  } while (token);
}
console.log(`飞书侧徐彬程未同步任务：${candidates.length} 条`);
for (const c of candidates) console.log(`  - [${c.tasklist}] ${c.name.slice(0, 60)} (${c.org ?? "?"}/${c.repo ?? "?"})`);

// ── PingCode 侧：token → 项目映射 → 去重 → 建单 ────────────────
if (candidates.length > 0) {
  const q = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.PINGCODE_CLIENT_ID ?? "",
    client_secret: process.env.PINGCODE_CLIENT_SECRET ?? "",
  });
  const tok = (await (await fetch(`https://open.pingcode.com/v2/auth/token?${q}`)).json()).access_token;
  if (!tok) throw new Error("PingCode token 获取失败");
  const PH = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const projects = ((await (await fetch("https://open.pingcode.com/v2/pjm/projects", { headers: PH })).json()).values ?? []) as any[];
  const idByAbbr: Record<string, string> = {};
  for (const p of projects) idByAbbr[p.identifier] = p.id;

  // 去重：目标项目现有工单 subject 集合
  const subjects = new Set<string>();
  for (const abbr of new Set(Object.values(ORG2PROJECT))) {
    if (!idByAbbr[abbr]) continue;
    let off = 0;
    for (let i = 0; i < 20; i++) {
      const r = await (await fetch(`https://open.pingcode.com/v2/pjm/workitems?project_id=${idByAbbr[abbr]}&offset=${off}&limit=100`, { headers: PH })).json();
      for (const w of r.values ?? []) subjects.add((w.subject ?? "").trim());
      if ((r.values ?? []).length === 0 || (r.total && off + (r.values ?? []).length >= r.total)) break;
      off += (r.values ?? []).length;
    }
  }

  for (const c of candidates) {
    const abbr = c.org ? ORG2PROJECT[c.org] : undefined;
    if (!abbr || !idByAbbr[abbr]) {
      console.log(`⏭️ 「${c.name.slice(0, 40)}」org=${c.org ?? "?"} 无 PingCode 项目映射，跳过（不瞎猜）`);
      continue;
    }
    if (subjects.has(c.name.trim())) {
      console.log(`⏭️ 「${c.name.slice(0, 40)}」同名工单已存在于 ${abbr}，跳过`);
      continue;
    }
    if (!APPLY) {
      console.log(`DRY-RUN 将创建 → ${abbr}: ${c.name.slice(0, 60)}`);
      continue;
    }
    const desc = [c.description, c.url ? `飞书任务：${c.url}` : "", "（由 feishu→pingcode 同步脚本创建，负责人：徐彬程）"].filter(Boolean).join("\n\n");
    const resp = await fetch("https://open.pingcode.com/v2/pjm/workitems", {
      method: "POST", headers: PH,
      body: JSON.stringify({ project_id: idByAbbr[abbr], title: c.name.trim(), description: desc, type_id: WORKITEM_TYPE_ID }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || (!body.id && !body.access_token && !body.subject)) {
      console.log(`❌ 创建失败（HTTP ${resp.status}）：${JSON.stringify(body).slice(0, 300)} —— 停止后续创建`);
      break;
    }
    const detail = await (await fetch(`https://open.pingcode.com/v2/pjm/workitems/${body.id}`, { headers: PH })).json();
    console.log(`✅ 已创建 ${detail.whole_identifier ?? body.id} ← 「${c.name.slice(0, 50)}」（回读 state=${detail.state?.name ?? "?"}）`);
  }
}
console.log(APPLY ? "\n--apply 完成" : "\nDRY-RUN 结束（加 --apply 真正创建）");
