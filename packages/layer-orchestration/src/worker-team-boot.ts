/**
 * worker-team-boot — 工人小组装配与驱动循环（bootstrap 侧接线）
 *
 * 把 P0 核心逻辑（worker-team.ts）接进运行时：
 *   - callWorker：经 SeamContext.call 按成员 serviceId 调 @action/*-agent
 *     （与 app-dev.ts 的 agentRefs 同款解析方式；返回 {text} 归一为小组调用面）；
 *   - resolveCwd：config/project-registry.json 的 project_id → gitea_repos[0]
 *     → 本机仓库根（~/AI/<repo 短名>；可 WORKER_TEAM_REPO_ROOT 覆盖根目录）；
 *   - startWorkerTeamLoop：周期扫台账 ready 队列（同 startBriefingDigestScheduler
 *     的 setInterval 形态），WORKER_TEAM_INTERVAL_MS 控制节拍（0=停用）。
 *
 * 装配原则（负责人 09-02 拍板）：harness 侧只编排，不复制 project 治理——
 * agentd 成员走 agentd-executor 原有链路（闸门/审计在 agentd），本循环只管轻型成员。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { err, ok } from "@aigility-harness/core";
import type { SeamContext } from "@aigility-harness/core";
import { WorkerTeam } from "./worker-team.js";
import type { WorkerTeamOptions, WorkerMember } from "./worker-team.js";
import type { TaskRegistry } from "./task-registry.js";

/** 轻型成员名册（P0 硬编码；与 @action 四工人服务对应） */
export const LIGHT_ROSTER: WorkerMember[] = [
  { id: "codex", serviceId: "@action/codex-agent", tier: "light" },
  { id: "claude", serviceId: "@action/claude-agent", tier: "light" },
  { id: "zcode", serviceId: "@action/zcode-agent", tier: "light" },
  { id: "pi", serviceId: "@action/pi-agent", tier: "light" },
];

/** 成员 id → CapabilityRef（ctx.call 用） */
function memberRef(serviceId: string): { id: string; versionRange: string } {
  return { id: serviceId, versionRange: "^1.0.0" };
}

/** callWorker 装配：ctx.call → {ok,text,error} 归一 */
export function makeCallWorker(ctx: SeamContext): WorkerTeamOptions["callWorker"] {
  return async (member, args) => {
    const r = (await ctx.call(memberRef(member.serviceId), {
      prompt: args.prompt,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      // planning 模型显式化：codex-agent 默认 deepseek-v4-pro 本机网关不存在
      //（2026-10-12 e2e 实测 HTTP 400）；qwen-turbo 亦仅适用于旧网关。本机
      // LiteLLM 网关可用模型以 404 报错回显为准，缺省 deepseek-v4-flash（带
      // fallback）；可用 WORKER_TEAM_PLANNING_MODEL 覆盖。
      planningModel: process.env["WORKER_TEAM_PLANNING_MODEL"] ?? "deepseek-v4-flash",
    } as Record<string, unknown>)) as { ok: boolean; value?: { text?: string }; error?: string };
    if (!r.ok) return { ok: false, text: "", error: r.error ?? "成员调用失败" };
    return { ok: true, text: r.value?.text ?? "" };
  };
}

/** project-registry.json 条目（只取本接线用到的字段） */
interface ProjectRegistryEntry {
  project_id: string;
  gitea_repos?: string[];
}

/**
 * resolveCwd 装配：projectRef（org/repo 或 project_id）→ 本机仓库根。
 * 映射规则：project-registry 命中 project_id → gitea_repos[0] 短名；
 * 否则 projectRef 自身短名。目录试探：WORKER_TEAM_REPO_ROOT（默认 ~/AI）/<短名>。
 * 找不到返回 undefined（成员用自身 cwd 兜底，不阻断派发）。
 */
export function makeResolveCwd(opts: {
  registryFile?: string;
  repoRoot?: string;
} = {}): NonNullable<WorkerTeamOptions["resolveCwd"]> {
  const repoRoot = opts.repoRoot ?? process.env["WORKER_TEAM_REPO_ROOT"] ?? join(homedir(), "AI");
  const regFile = opts.registryFile
    ?? process.env["WORKER_TEAM_PROJECT_REGISTRY"]
    ?? join(process.cwd(), "config", "project-registry.json");
  let entries: ProjectRegistryEntry[] = [];
  try {
    if (existsSync(regFile)) {
      const raw = JSON.parse(readFileSync(regFile, "utf-8")) as { projects?: ProjectRegistryEntry[] };
      entries = Array.isArray(raw.projects) ? raw.projects : [];
    }
  } catch {
    // 配置缺失不致命：resolveCwd 退化为短名试探
  }
  return (projectRef: string): string | undefined => {
    const entry = entries.find((e) => e.project_id === projectRef);
    const short = entry?.gitea_repos?.[0]?.split("/").pop()
      ?? projectRef.split("/").pop()
      ?? projectRef;
    const dir = join(repoRoot, short);
    return existsSync(dir) ? dir : undefined;
  };
}

/** 组装完整 WorkerTeam（feishu-task-loop bootstrap 一行接入用） */
export function createWorkerTeam(opts: {
  ctx: SeamContext;
  registry: TaskRegistry;
  timeoutMs?: number;
}): WorkerTeam {
  return new WorkerTeam(
    {
      registry: opts.registry,
      callWorker: makeCallWorker(opts.ctx),
      resolveCwd: makeResolveCwd(),
      defaultTimeoutMs: opts.timeoutMs,
    },
    LIGHT_ROSTER,
  );
}

/**
 * 驱动循环：周期 takeReady（轻型成员接单）。
 * 返回 stop()；WORKER_TEAM_INTERVAL_MS=0 时不起循环（仍可用 createWorkerTeam 手动派发）。
 * 并发保护：上一拍未结束则跳过本拍（工人调用分钟级，节拍默认 60s）。
 */
export function startWorkerTeamLoop(opts: {
  team: WorkerTeam;
  /** 节拍毫秒；env WORKER_TEAM_INTERVAL_MS 优先；0=不启动 */
  intervalMs?: number;
  /** 每拍最多接几单（默认 3） */
  batchLimit?: number;
}): { stop: () => void } {
  const env = Number(process.env["WORKER_TEAM_INTERVAL_MS"] ?? "");
  const interval = env === 0 ? 0 : (Number.isFinite(env) && env > 0 ? env : opts.intervalMs ?? 60_000);
  if (interval === 0) {
    console.log("[worker-team] 驱动循环未启用（WORKER_TEAM_INTERVAL_MS=0）");
    return { stop: () => {} };
  }
  let busy = false;
  const tick = async () => {
    if (busy) return; // 上一拍未结束，跳过
    busy = true;
    try {
      const results = await opts.team.takeReady(opts.batchLimit ?? 3);
      for (const { uid, result } of results) {
        if (result.ok) console.log(`[worker-team] ${uid} ✅ ${result.value}`);
        else console.error(`[worker-team] ${uid} ❌ ${result.error}`);
      }
    } catch (e) {
      console.error(`[worker-team] 拍异常: ${String((e as Error)?.message ?? e)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), interval);
  console.log(`[worker-team] 驱动循环已启动（节拍 ${interval}ms，名册 ${LIGHT_ROSTER.map((w) => w.id).join("/")}）`);
  return { stop: () => clearInterval(timer) };
}
