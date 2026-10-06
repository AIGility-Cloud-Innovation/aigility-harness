/**
 * dryrun-registry.ts — 收集侧/放行链干跑（面向人工测试）
 *
 * 做什么：真实拉取 飞书任务清单 + Gitea open 工单（只读）→ TaskRegistry
 * 收敛 → 定期对齐器单轮（查重复/冲突/独占巡检）→ 五要素放行检查单
 * （真实 LiteLLM）→ 本地模拟 人工放行 / 执行独占。
 *
 * 边界：外部系统全程只读；登记表落 /tmp 本地 JSON；「人工放行」「claim」
 * 只作用于本地登记表，绝不回写飞书/Gitea/agentd。
 *
 * 用法：pnpm exec tsx scripts/dryrun-registry.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { feishuApiProvider } from "@aigility-harness/layer-action";
import {
  TaskRegistry,
  collectFeishuTasks,
  collectGiteaIssues,
  alignOnce,
  runReleaseGate,
  loadReleaseDoc,
  createFeishuTaskProvider,
  createGiteaIssueProvider,
  FEISHU_TASK_PROVIDER_ID,
  GITEA_ISSUE_PROVIDER_ID,
  AGENTD_TASK_PROVIDER_ID,
} from "@aigility-harness/layer-orchestration";
import type { FeishuApiResultLike, GiteaApiResultLike, TaskProvider } from "@aigility-harness/layer-orchestration";

// ── 环境 ─────────────────────────────────────────────────────────
for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const REGISTRY_FILE = "/tmp/task-registry-dryrun.json";
const RELEASE_YAML = join(dirname(fileURLToPath(import.meta.url)), "../workflows/task-release.yaml");
const REGISTRY = JSON.parse(readFileSync(join(REPO_ROOT, "config/project-registry.json"), "utf-8")) as {
  projects: Array<{ project_id: string; gitea_repos?: string[] }>;
};
const REPOS = REGISTRY.projects.flatMap((p) => p.gitea_repos ?? []);
const ORG_LISTS = [...new Set(REPOS.map((r) => r.split("/")[0]))];

const section = (t: string) => console.log(`\n━━━ ${t} ━━━`);

// ── 注入桩：feishu / gitea / llm ─────────────────────────────────
const ctxStub = { emit: () => {}, traceId: "dryrun" } as never;
const feishuCall = async (req: Record<string, unknown>): Promise<FeishuApiResultLike> => {
  const r = await feishuApiProvider.execute(req as never, ctxStub);
  return r.ok ? { ok: true, value: { code: r.value?.code, msg: r.value?.msg, data: r.value?.data } } : { ok: false, error: r.error };
};

const giteaToken = readFileSync(join(process.env["HOME"] ?? "~", ".gitea-token"), "utf-8").trim();
const giteaCall = async (req: Record<string, unknown>): Promise<GiteaApiResultLike> => {
  const qs = new URLSearchParams(
    Object.entries((req["query"] as Record<string, string>) ?? {}).map(([k, v]) => [k, String(v)]),
  ).toString();
  const resp = await fetch(`https://git.aigility.cloud/api/v1${req["path"]}${qs ? `?${qs}` : ""}`, {
    headers: { authorization: `token ${giteaToken}` },
  });
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, value: { status: resp.status, data } };
};

const llmCall = async (req: { system: string; user: string }) => {
  const model = process.env["LLM_MODEL"] || "qwen-turbo";
  const resp = await fetch(`${process.env["LITELLM_URL"] || "http://127.0.0.1:48724"}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env["LITELLM_KEY"] || "sk-1234"}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
  });
  const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { ok: resp.ok, value: { text: j.choices?.[0]?.message?.content } };
};

// ── 主流程 ───────────────────────────────────────────────────────
const registry = new TaskRegistry(REGISTRY_FILE);

section("① 对齐器单轮（收集 → 重复收敛 → 冲突/独占巡检）");
const providers: TaskProvider[] = [
  createFeishuTaskProvider(feishuCall, { tasklistNames: ORG_LISTS }),
  createGiteaIssueProvider(giteaCall, { repos: REPOS }),
];
// 注：agentd 存量收集（createAgentdTaskProvider）需 UDS 在线，干跑环境缺省不接

const report = await alignOnce(registry, providers);
for (const [id, s] of Object.entries(report.collected.byProvider)) {
  console.log(`  [${id}] 扫描 ${s.scanned} / 新收编 ${s.adopted} / 去重 ${s.existing}${s.errors.length ? ` / 错误 ${s.errors.length}` : ""}`);
}
console.log(`  重复合并: ${report.merged.length}${report.merged.length ? ` → ${report.merged.map((m) => `${m.absorbed.slice(0, 12)}…并入${m.keep.slice(0, 12)}…`).join(", ")}` : ""}`);
console.log(`  冲突: ${report.conflicts.length} / 独占异常: ${report.exclusivity.length}`);

section("② 合成样本（五要素齐全，验证 LLM 判定与自动放行）");
const demo = registry.adopt({
  title: "【dryrun 合成】修复账单导出列错位",
  description:
    "现状：账单导出表格与实际账单列错位，财务对账失败。" +
    "过程方法：修复导出模板渲染逻辑，补充对账单测。" +
    "目标：导出文件与账单字段完全一致，对账用例通过。" +
    "执行者：agentd",
  origin: { provider: FEISHU_TASK_PROVIDER_ID, guid: "dryrun-demo-1" },
  projectRef: "TiMEM-AI/timem-platform-backend",
});
console.log(`  ${demo.uid} (planned)`);

section("③ 登记表快照");
const all = registry.list();
console.log(`  共 ${all.length} 条：`);
for (const r of all.slice(0, 30)) {
  console.log(
    `  ${r.uid.slice(0, 13)}… [${r.status}] ${r.title.slice(0, 38)}${r.projectRef ? `  @${r.projectRef}` : ""}  links={${Object.keys(r.links).join(",")}}`,
  );
}
if (all.length > 30) console.log(`  …（其余 ${all.length - 30} 条见 ${REGISTRY_FILE}）`);

section("④ 五要素放行检查单（真实 LLM）");
const docInfo = loadReleaseDoc(RELEASE_YAML);
console.log(`  检查单来源: ${docInfo.source}  节点开关: ${Object.entries(docInfo.doc.nodes).map(([k, v]) => `${k}=${v.enabled !== false}`).join(" / ")}`);
// 合成样本排首位（验证 LLM 判定与自动放行全链路），其余取前 5 条 planned
const planned = [
  demo,
  ...registry.list({ status: ["planned"] }).filter((r) => r.uid !== demo.uid),
].slice(0, 6);
for (const r of planned) {
  const res = await runReleaseGate(registry, r.uid, docInfo.doc, llmCall);
  if (!res.ok) {
    console.log(`  ${r.uid.slice(0, 13)}… ❌ ${res.error}`);
    continue;
  }
  const d = res.value.decision;
  console.log(`  ${r.uid.slice(0, 13)}… ${d.action === "auto-release" ? "✅ 自动放行" : d.action === "pending-review" ? "⏸ 待复核" : "🏷 缺要素"}` +
    (d.missing.length ? ` 缺: ${d.missing.join("/")}` : "") +
    (d.tags.length ? ` ${d.tags.join("")}` : ""));
}

section("⑤ 本地模拟：人工放行（记录复核人，不回写外部系统）");
const pending = registry.list({ status: ["planned"] })[0];
if (pending) {
  const res = registry.approve(pending.uid, { via: "manual", by: "johnny", note: "dryrun 人工放行演示" });
  console.log(res.ok
    ? `  ${pending.uid.slice(0, 13)}… ✅ johnny 批准 → ready  review=${JSON.stringify(registry.get(pending.uid)?.review)}`
    : `  ❌ ${res.error}`);
} else {
  console.log("  （无 planned 任务可演示，跳过）");
}

section("⑥ 本地模拟：执行独占（claim / 改派拒绝）");
const ready = registry.list({ status: ["ready"] })[0];
if (ready) {
  const c1 = registry.claim(ready.uid, AGENTD_TASK_PROVIDER_ID, "dryrun-agent-1");
  console.log(`  agentd 领取: ${c1.ok ? "✅" : `❌ ${c1.error}`}`);
  const c2 = registry.claim(ready.uid, GITEA_ISSUE_PROVIDER_ID, "org/repo#0");
  console.log(`  改派真人:   ${c2.ok ? "✅（不应出现）" : `🚫 被拒 ✅ ${c2.error}`}`);
} else {
  console.log("  （无 ready 任务可演示，跳过）");
}

registry.flushSync();
section("完成");
console.log(`  登记表快照: ${REGISTRY_FILE}`);
console.log("  变体测试：编辑 workflows/task-release.yaml（如 llm_elements.enabled: false）后重跑本脚本，观察放行行为变化。");
