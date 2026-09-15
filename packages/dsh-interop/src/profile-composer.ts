/**
 * dshProfileComposer — M2② profile 组合器（docs/dsh-生态共建规划.md §七）。
 *
 * 组合侧镜像官方语义（@deepseek-ai/dsh-app-boot 的 applyEntryPatches，拆包
 * 实测核对过）：空根 + patch 层顺序应用，条目两类——
 *   - {insert: [...]}            无 id 追加到根列表；带 id 追加进目标 group 条目
 *   - {id, name?, ...overrides}  按 id 定位逐键覆盖（config 整体替换，非深合并；
 *                                name 不匹配 / 目标缺失 → 告警跳过，不抛错）
 * 层顺序 = bundles（package.json 的 dsh.bundle.patch）→ 内存 patch 层 →
 * 遥测硬关闭（§三.5：我们的 profile 默认关遥测，对齐官方 resolveTelemetryPatch）。
 * 同 id 后写者胜（last-write-wins per row）。组合不发生求值——`!!js` 保持
 * 原文，求值只发生在装载前（js-expr.ts 白名单求值器）。
 *
 * 装载侧是「依赖感知成组装载」：读每个插件导出的 cordis 元数据
 * （provide/inject），拓扑分层后按序 mountDshRow；供给者先行，环与
 * 环外依赖退回原序并告警（cordis 激活本就由服务可用性驱动，排序是
 * 确定性与可读性手段，不是正确性前提）。
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { CapabilityMountResult } from "@aigility-harness/core";
import { isJsExpr, parsePatchEntries, type JsExpr } from "./base-rows.js";
import { evaluateDeep, type JsExprEvalContext } from "./js-expr.js";
import { mountDshRow, pickPluginExport, resolvePluginModule } from "./interop.js";

const localRequire = createRequire(import.meta.url);

/** 官方 resolveTelemetryPatch 硬关闭的目标行（dsh lib 常量，实测核对） */
export const TELEMETRY_ROW_ID = "session-telemetry-otel";

/** 官方 patch 层的条目（组合输入） */
export interface DshPatchEntry {
  id?: string;
  name?: string;
  config?: unknown;
  disabled?: boolean | JsExpr;
  /** group 条目: config 是子条目数组（官方 loader 按 group 整体装载） */
  group?: boolean;
  /** 本工程扩展: 包内多插件导出时指定导出名（官方行不需要） */
  exportName?: string;
  insert?: DshPatchEntry[];
  [key: string]: unknown;
}

/** 组合产出的有效行（`!!js` 保持原文，装载前才求值） */
export interface ComposedRow {
  id?: string;
  name: string;
  config?: unknown;
  disabled?: boolean | JsExpr;
  exportName?: string;
  /** group 条目: config 是子条目数组（装载时递归子行） */
  group?: boolean;
}

export interface ComposeProfileOptions {
  /** bundle 包名列表（对齐 profile package.json 的 dsh.profile.bundles 顺序） */
  bundles?: string[];
  /** 内存 patch 层，依次应用（在 bundles 之后，最后优先） */
  patches?: DshPatchEntry[][];
  /** 遥测硬关闭（默认 true —— 我们 profile 的默认立场，§三.5） */
  disableTelemetry?: boolean;
}

export interface ComposeResult {
  rows: ComposedRow[];
  warnings: string[];
}

/* ── 组合：官方 applyEntryPatches 的等价实现 ───────────────────── */

interface PatchRow extends ComposedRow {
  group?: boolean;
  config?: unknown;
  [key: string]: unknown;
}

function applyEntryPatches(
  data: PatchRow[],
  patches: DshPatchEntry[],
  warn: (msg: string) => void,
): PatchRow[] {
  const entryMap = new Map<string, PatchRow>();
  const buildMap = (entries: PatchRow[]): void => {
    for (const entry of entries) {
      if (typeof entry.id === "string") entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) {
        buildMap(entry.config as PatchRow[]);
      }
    }
  };
  buildMap(data);

  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target) {
          warn(`patch insert: 条目 ${JSON.stringify(id)} 未找到，跳过`);
          continue;
        }
        if (!target.group) {
          warn(`patch insert: 条目 ${JSON.stringify(id)} 不是 group，跳过`);
          continue;
        }
        if (!Array.isArray(target.config)) target.config = [];
        (target.config as PatchRow[]).push(...(structuredClone(insert) as PatchRow[]));
      } else {
        data.push(...(structuredClone(insert) as PatchRow[]));
      }
      buildMap(data);
      continue;
    }
    if (typeof id !== "string") {
      warn("patch: 非 insert 条目缺 id，跳过");
      continue;
    }
    const target = entryMap.get(id);
    if (!target) {
      warn(`patch: 条目 ${JSON.stringify(id)} 未找到，跳过`);
      continue;
    }
    if (typeof name === "string" && name !== target.name) {
      warn(
        `patch: 条目 ${JSON.stringify(id)} 的 name 不匹配 (期望 ${JSON.stringify(target.name)}，得到 ${JSON.stringify(name)})，跳过`,
      );
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = structuredClone(value);
    }
  }
  return data;
}

/** bundle 包名 → patch 条目层（读包内 dsh.bundle.patch 清单；缺失即配置错误） */
function loadBundleLayer(bundle: string): DshPatchEntry[] {
  const pkgPath = localRequire.resolve(`${bundle}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dsh?: { bundle?: { patch?: string } };
  };
  const rel = pkg.dsh?.bundle?.patch;
  if (!rel) {
    throw new Error(`${bundle} 缺少 dsh.bundle 清单——把无 bundle 的包列进 bundles 是配置错误`);
  }
  const raw = readFileSync(path.join(path.dirname(pkgPath), rel), "utf8");
  return parsePatchEntries(raw) as unknown as DshPatchEntry[];
}

/** 官方 composeEntries 等价：空根 + 各层顺序应用 */
export function composeProfileRows(opts?: ComposeProfileOptions): ComposeResult {
  const warnings: string[] = [];
  const warn = (msg: string): void => {
    warnings.push(msg);
  };
  const bundles = opts?.bundles ?? ["@deepseek-ai/dsh-base"];
  const layers: DshPatchEntry[][] = bundles.map(loadBundleLayer);
  layers.push(...(opts?.patches ?? []));

  let rows = applyEntryPatches([], layers.flat(1), warn);

  // 遥测硬关闭（对齐官方 resolveTelemetryPatch：仅当行存在时下发 disable 补丁）
  if (opts?.disableTelemetry !== false) {
    const hasRow = rows.some((r) => r.id === TELEMETRY_ROW_ID);
    if (hasRow) {
      rows = applyEntryPatches(rows, [{ id: TELEMETRY_ROW_ID, disabled: true }], warn);
    }
  }

  const out: ComposedRow[] = rows
    .filter((r) => typeof r.name === "string" && r.name.length > 0)
    .map((r) => ({
      id: typeof r.id === "string" ? r.id : undefined,
      name: r.name,
      config: r.config ?? undefined,
      disabled: (r.disabled ?? undefined) as ComposedRow["disabled"],
      exportName: typeof r.exportName === "string" ? r.exportName : undefined,
      ...(r.group === true ? { group: true as const } : {}),
    }));
  return { rows: out, warnings };
}

/* ── 装载：依赖感知成组装载 ─────────────────────────────────────── */

export interface RowDependencyMeta {
  /** 该行提供的服务名（插件导出的 provide，string 或 string[]） */
  provides: string[];
  /** 该行注入的服务名（插件导出的 inject，数组形式或 record 的键） */
  injects: string[];
}

/**
 * 纯函数：按 provide/inject 元数据拓扑排序。
 * 供给者先行；环与无人供给的注入不阻塞（cordis 由服务可用性驱动激活），
 * 保留原相对顺序并产出告警。
 */
export function orderRowIndices(metas: RowDependencyMeta[]): {
  order: number[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const providerOf = new Map<string, number>();
  metas.forEach((m, i) => {
    for (const svc of m.provides) {
      if (!providerOf.has(svc)) providerOf.set(svc, i);
    }
  });
  // 边: 注入者 → 供给者（Kahn 入度建在供给者上）
  const dependents = new Map<number, Set<number>>();
  const indegree = new Array<number>(metas.length).fill(0);
  metas.forEach((m, i) => {
    for (const svc of m.injects) {
      const p = providerOf.get(svc);
      if (p === undefined || p === i) continue;
      if (!dependents.get(p)) dependents.set(p, new Set());
      const set = dependents.get(p)!;
      if (!set.has(i)) {
        set.add(i);
        indegree[i]++;
      }
    }
  });
  const order: number[] = [];
  // 同层按原序出队：用指针扫描保证确定性
  const ready = metas.map((_, i) => i).filter((i) => indegree[i] === 0);
  let scan = 0;
  while (scan < ready.length) {
    const i = ready[scan++];
    order.push(i);
    for (const dep of dependents.get(i) ?? []) {
      if (--indegree[dep] === 0) ready.push(dep);
    }
  }
  if (order.length < metas.length) {
    const stuck = metas.map((_, i) => i).filter((i) => indegree[i] > 0);
    warnings.push(
      `依赖环或未满足注入，以下行退回原序装载: ${stuck.map((i) => `#${i}`).join(", ")}`,
    );
    order.push(...stuck);
  }
  return { order, warnings };
}

/** 读插件导出的 cordis 依赖元数据（provide/inject；函数与对象两种形态都认） */
function readDependencyMeta(plugin: unknown): RowDependencyMeta {
  const src = (
    typeof plugin === "function" ? plugin : typeof plugin === "object" && plugin !== null ? plugin : {}
  ) as { provide?: unknown; inject?: unknown };
  const normalize = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (typeof v === "object" && v !== null) {
      return Object.keys(v).filter((k) => {
        const required = (v as Record<string, unknown>)[k];
        return required !== false;
      });
    }
    return [];
  };
  return { provides: normalize(src.provide), injects: normalize(src.inject) };
}

/** 行装载结果 = 契约结果 + 行名（union 用交叉扩展） */
export type ProfileRowResult = CapabilityMountResult & { name?: string };

export interface MountProfileResult {
  results: ProfileRowResult[];
  mounted: number;
  failed: number;
  skipped: number;
  warnings: string[];
}

export interface MountProfileOptions {
  /** 调用方解析基准（同 mountDshRow） */
  resolveFrom?: string;
  /** `!!js` 求值上下文（env/platform/cwd/dshHome 替身，测试与隔离用） */
  evalCtx?: JsExprEvalContext;
  /** 不真正装载，只产出排序与告警（预览） */
  dryRun?: boolean;
}

/**
 * 依赖感知成组装载：disabled 行（含 `!!js` 平台门控求值后为真者）跳过；
 * 其余行按 provide/inject 拓扑序 mountDshRow。group 行递归装载子行
 * （M2 的官方清单暂无 group，语义先就位）。
 */
export async function mountComposedProfile(
  ctx: Context,
  rows: ComposedRow[],
  opts?: MountProfileOptions,
): Promise<MountProfileResult> {
  const warnings: string[] = [];

  // 1) 平台门控等 disabled 求值 + 展开 group 子行
  const active: { row: ComposedRow; config: unknown }[] = [];
  const consider = (row: ComposedRow): void => {
    const disabled =
      typeof row.disabled === "boolean"
        ? row.disabled
        : isJsExpr(row.disabled)
          ? Boolean(evaluateDeep(row.disabled, opts?.evalCtx))
          : false;
    if (disabled) return;
    if (row.group && Array.isArray(row.config)) {
      for (const child of row.config as ComposedRow[]) consider(child);
      return;
    }
    active.push({ row, config: evaluateDeep(row.config, opts?.evalCtx) });
  };
  for (const row of rows) consider(row);

  // 2) 读元数据定拓扑序（解析失败的行按原序、装载时走 failed 通道）
  const metas = new Array<RowDependencyMeta | null>(active.length).fill(null);
  await Promise.all(
    active.map(async ({ row }, i) => {
      try {
        const mod = await resolvePluginModule(row.name, { resolveFrom: opts?.resolveFrom });
        const plugin = pickPluginExport(mod, row.exportName);
        if (plugin !== undefined) metas[i] = readDependencyMeta(plugin);
      } catch {
        /* 装载阶段统一报 failed */
      }
    }),
  );
  const known = metas.map((m, i) => m ?? { provides: [], injects: [] });
  const { order, warnings: orderWarn } = orderRowIndices(known);
  warnings.push(...orderWarn);

  // 3) 无人供给的注入 → 告警（可能由宿主 Context 运行时供给）
  const provided = new Set<string>();
  for (const m of metas) for (const svc of m?.provides ?? []) provided.add(svc);
  const unsatisfied = new Set<string>();
  for (const m of metas) {
    for (const svc of m?.injects ?? []) {
      if (!provided.has(svc)) unsatisfied.add(svc);
    }
  }
  if (unsatisfied.size > 0) {
    warnings.push(
      `以下注入在本行集内无人供给（宿主若未提供则对应行不会激活）: ${[...unsatisfied].join(", ")}`,
    );
  }

  // 4) 按序装载。cordis 服务唯一：同一插件（包+导出）重复行只装载首行，
  //    后续行报 skipped——官方清单本就一行一插件，这是防御性去重。
  const results: ProfileRowResult[] = [];
  const seenPlugin = new Set<string>();
  if (!opts?.dryRun) {
    for (const i of order) {
      const { row, config } = active[i];
      const key = `${row.name}\u0000${row.exportName ?? ""}`;
      if (seenPlugin.has(key)) {
        results.push({
          status: "skipped",
          id: row.id,
          name: row.name,
          reason: "duplicate plugin (cordis 服务唯一, 重复行只装载首行)",
        });
        continue;
      }
      seenPlugin.add(key);
      const r = await mountDshRow(
        ctx,
        {
          id: row.id,
          name: row.name,
          config: config as Record<string, unknown> | undefined,
          exportName: row.exportName,
        },
        { resolveFrom: opts?.resolveFrom },
      );
      results.push({ ...r, name: row.name });
    }
  }

  return {
    results,
    mounted: results.filter((r) => r.status === "mounted").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: rows.length - active.length,
    warnings,
  };
}
