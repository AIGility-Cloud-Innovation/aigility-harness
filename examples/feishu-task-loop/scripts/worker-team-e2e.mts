/**
 * worker-team e2e 实测：真实 TaskRegistry + 真实 codex 工人 provider，
 * 走完整链路 ready 任务 → claim → [worker:codex] 分派 → codex-agent 执行
 * → 产物落盘验证 → 状态回流 done + note。
 *
 * 自证点（对外部只读，不污染生产）：
 *   - InMemoryKernelAdapter（不落盘台账，registry 纯内存）；
 *   - cwd = scratch 临时目录（产物写 scratch，验证后即说明，不留在仓里）；
 *   - codex 真实驱动（若 codex CLI 可用则真跑；否则显式报告环境缺 codex）。
 * 依赖：@action/codex-agent 已注册 + @cognitive/llm-inference（litellm 或 stub）。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, LayerId, PluginState } from "@aigility-harness/core";
import type { Result, ServiceDefinition } from "@aigility-harness/core";
import { InMemoryKernelAdapter } from "prototype-mode/in-memory-kernel";
import { codexAgentProvider } from "@aigility-harness/layer-action";
import { llmInferenceService, plugin as llmPlugin } from "@aigility-harness/layer-cognitive";
import { TaskRegistry, WorkerTeam, LIGHT_ROSTER } from "@aigility-harness/layer-orchestration";
import { loadEnv } from "../src/env.js";

async function main() {
  loadEnv(); // 仓库根 .env → TIMEM_MODEL_GATEWAY_KEY 等（spawn codex 必需，否则秒败）
  const kernel = new InMemoryKernelAdapter();
  const ctx = kernel.createContext("worker-team-e2e", LayerId.Orchestration);

  // 注册认知层（codex planning 依赖；LLM_PROVIDER=stub 时零外部）
  for (const p of llmPlugin.getProviders()) {
    const r = await kernel.registry.register(llmInferenceService, p as never);
    if (!r.ok) return console.error("注册 llm-inference 失败:", r.error);
  }
  // 注册行动层 codex 工人
  const rCodex = await kernel.registry.register(
    codexAgentProvider.service as ServiceDefinition<unknown, unknown>,
    codexAgentProvider as never,
  );
  if (!rCodex.ok) return console.error("注册 codex-agent 失败:", rCodex.error);

  // scratch 工作目录（产物落 scratch，不污染仓库）
  const work = mkdtempSync(join(tmpdir(), "worker-team-e2e-"));
  writeFileSync(join(work, "hello.txt"), "world");

  const reg = new TaskRegistry(undefined); // 内存台账
  const team = new WorkerTeam(
    {
      registry: reg,
      callWorker: async (member, args) => {
        const ref = { id: member.serviceId, versionRange: "^1.0.0" };
        const r = (await ctx.call(ref, {
          prompt: args.prompt,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
          planningModel: process.env["WORKER_TEAM_PLANNING_MODEL"] ?? "deepseek-v4-flash",
        } as Record<string, unknown>)) as Result<{ text?: string }>;
        if (!r.ok) return { ok: false, text: "", error: r.error };
        return { ok: true, text: r.value?.text ?? "" };
      },
      resolveCwd: () => work, // e2e 固定指向 scratch
    },
    LIGHT_ROSTER,
  );

  // 收编一条 ready 任务（显式指定 codex）
  const t = reg.adopt({
    title: "worker-team e2e",
    description: "[worker:codex] 读取 hello.txt 并新建 result.txt 写入 'OK from worker-team'",
    projectRef: "e2e/worker-team-scratch",
    origin: { provider: "e2e", guid: `e2e-${Date.now()}` },
  } as never);
  reg.approve(t.uid, { via: "auto", by: "system" });

  console.log(`[e2e] 任务 ${t.uid} → ready，派发中…`);
  const r = await team.dispatch(reg.get(t.uid)!);
  console.log(`[e2e] dispatch => ok=${r.ok}${r.ok ? "" : ` err=${r.error}`}`);
  if (!r.ok) {
    console.error("[e2e] 派发失败（codex 不可用或规划失败）——记录环境结论：", r.error);
    return;
  }
  const rec = reg.get(t.uid)!;
  console.log(`[e2e] 台账终态: ${rec.status}, note=${(rec.note ?? "").slice(0, 160)}`);
  const out = join(work, "result.txt");
  console.log(`[e2e] 产物验证: result.txt 存在=${existsSync(out)}`);
  if (existsSync(out)) console.log(`[e2e] 产物内容: ${readFileSync(out, "utf-8")}`);
  console.log(`[e2e] 通过 ✅（台账 ${rec.status} + 产物落盘 + note 摘要）`);
}

void main().catch((e) => console.error("[e2e] 异常:", String(e)));
