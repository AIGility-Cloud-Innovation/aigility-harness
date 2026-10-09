/**
 * FDE 生意台账域包插件（@action/fde-ledger）—— 示例本地 LayerPlugin（不改框架包）
 *
 * 把 fde-workbench 相对智悦多出来的核心资产——FDE 生意台账（线索→方案→合同→交付→续费）
 * ——以「域包插件 + 应用中心应用」双形态插入智悦（S1 挂接，见 docs/platform-module-plugin-design.md）：
 *   - 数据面：两站共用 AppBase PG，fde 台账持久化在 app_rows（虚拟 owner `app:fde-workbench`，
 *     表名 `fde_<slice>`，整片 items 存一行 JSONB）——本插件直读共库，不要求 fde 站点在跑；
 *   - 行动面：方案 DOCX 导出复用 D3 @action/doc-worker（块映射与 fde proposalDoc.ts 同构）；
 *   - 会话面：token 与 AppBase 同签发体系，应用中心「打开完整工作台」以 #ssw= 携票跳转免二次登录。
 *
 * 数据边界：读 fde 分片走平台底座共库（与 tasks/audit 同级），五域 Seam 只用于 doc-worker——
 * 与「引擎调用走 Seam、平台数据走 AppBase」的既有分层一致。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  PluginManifest,
  LayerPlugin,
  Result,
  HealthStatus,
} from "@aigility-harness/core";

import { pool } from "@aigility-harness/appbase/backend";

// ── 常量与最小类型（对齐 fde-workbench app/src/types，只取要渲染/导出的字段）──

export const FDE_DATA_OWNER = "app:fde-workbench";
const FDE_TABLE_PREFIX = "fde_";

/** 台账分片（与 fde-workbench AppContext 的 SLICES 对齐；summary 只取其中业务面） */
const SUMMARY_SLICES = [
  "leads", "proposals", "contracts", "deliveries", "deployments",
  "renewals", "channels", "knowledge",
] as const;

const STAGE_ORDER = ["新线索", "已联系", "拜访中", "方案中", "报价中", "谈判中", "已签约", "已交付", "已流失"] as const;

export interface FdeLeadLite {
  id: string; name: string; industry: string; scale: string;
  stage: string; owner: string; lastTouchAt: string;
}
export interface FdeProposalLite {
  id: string; leadId: string; title: string; createdAt: string;
  status: string; version: number; total: number;
}
export interface FdeContractLite {
  id: string; code: string; customer: string; amount: number;
  status: string; signDate?: string;
}
export interface FdeRenewalLite {
  id: string; customer: string; item: string;
  dueDate: string; amount: number; status: string;
}
export interface FdeDeliveryLite { id: string; customer: string; name: string; status: string }
export interface FdeDeploymentLite { id: string; customer: string; site: string; status: string }
export interface FdeKnowledgeLite { id: string; title: string; status: string; date: string }

export interface FdeLedgerSummary {
  ok: boolean;
  error?: string;
  /** 数据归属与新鲜度（共库直读, 不要求 fde 站点在跑） */
  source: string;
  updatedAt?: string;
  seeded: boolean;
  /** 完整工作台地址（S1 跳转, 服务端按 FDE_WEB_PORT 计算） */
  fdeWorkbenchUrl: string;
  counts: Record<string, number>;
  leadsByStage: Record<string, number>;
  contractAmount: { total: number; byStatus: Record<string, number> };
  renewalsDue: { count: number; amount: number };
  leads: FdeLeadLite[];
  proposals: FdeProposalLite[];
  contracts: FdeContractLite[];
  renewals: FdeRenewalLite[];
  deliveries: FdeDeliveryLite[];
  deployments: FdeDeploymentLite[];
  knowledge: FdeKnowledgeLite[];
}

export interface FdeLedgerRequest {
  action: "summary" | "proposal-doc";
  /** action = proposal-doc 时必填 */
  proposalId?: string;
}

// 方案导出所需字段（与 fde proposalDoc.ts 的映射契约对齐）
interface ProposalDocShape {
  id: string; leadId: string; title: string; createdAt: string; version: number; total: number;
  word: Array<{ heading: string; body: string }>;
  quote: Array<{ item: string; desc: string; amount: number }>;
  skus: string[];
  caseRefs: Array<{ kind: "proposal" | "deployment" | "knowledge"; id: string; title: string; reason: string }>;
}
interface SkuShape { id: string; name: string; spec: string; price: number; unit: string; billing: string }
const KIND_LABEL = { proposal: "历史方案", deployment: "已交付案例", knowledge: "知识库" } as const;

// ── 数据访问：读共库 fde 分片（整片 items 一行）──────────────────

async function readSlice(table: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT r.data, t.table_name
     FROM app_rows r JOIN app_tables t ON r.table_id = t.id
     WHERE t.owner_id = $1 AND t.table_name = $2
     ORDER BY r.created_at DESC LIMIT 1`,
    [FDE_DATA_OWNER, `${FDE_TABLE_PREFIX}${table}`],
  );
  const items = (rows[0]?.data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

/** 最近一次台账落库时间（分片行的 updated_at 最大值，说明数据新鲜度） */
async function ledgerUpdatedAt(): Promise<string | undefined> {
  const { rows } = await pool.query(
    `SELECT MAX(r.updated_at) AS at
     FROM app_rows r JOIN app_tables t ON r.table_id = t.id
     WHERE t.owner_id = $1 AND t.table_name LIKE $2`,
    [FDE_DATA_OWNER, `${FDE_TABLE_PREFIX}%`],
  );
  const at = rows[0]?.at;
  return at ? (at instanceof Date ? at.toISOString() : String(at)) : undefined;
}

const liteLead = (x: any): FdeLeadLite => ({
  id: String(x.id), name: String(x.name), industry: String(x.industry ?? ""), scale: String(x.scale ?? ""),
  stage: String(x.stage ?? ""), owner: String(x.owner ?? ""), lastTouchAt: String(x.lastTouchAt ?? ""),
});

// ── 服务定义 ─────────────────────────────────────────────────────

export const fdeLedgerService: ServiceDefinition<FdeLedgerRequest, FdeLedgerSummary | { ok: boolean; filename?: string; base64?: string; bytes?: number; error?: string }> = {
  id: "@action/fde-ledger",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "FDE 生意台账域包：共库直读 fde-workbench 台账（总览/清单）+ 方案 DOCX 导出（doc-worker）",
};

async function buildSummary(): Promise<FdeLedgerSummary> {
  const sliceData = await Promise.all(SUMMARY_SLICES.map((s) => readSlice(s)));
  const updatedAt = await ledgerUpdatedAt();
  const [leads, proposals, contracts, deliveries, deployments, renewals, channels, knowledge] = sliceData;

  const leadsByStage: Record<string, number> = {};
  for (const s of STAGE_ORDER) leadsByStage[s] = 0;
  for (const x of leads as any[]) leadsByStage[x?.stage] = (leadsByStage[x?.stage] ?? 0) + 1;

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const c of contracts as any[]) {
    const amount = Number(c?.amount) || 0;
    total += amount;
    byStatus[c?.status ?? "未知"] = (byStatus[c?.status ?? "未知"] ?? 0) + amount;
  }

  const dueRenewals = (renewals as any[]).filter((r) => r?.status === "待续费" || r?.status === "跟进中");

  const pick = (arr: unknown[], n: number) => arr.slice(0, n);
  return {
    ok: true,
    source: `${FDE_DATA_OWNER}（AppBase 共库直读）`,
    ...(updatedAt ? { updatedAt } : {}),
    seeded: leads.length > 0 || proposals.length > 0 || contracts.length > 0,
    fdeWorkbenchUrl: `http://127.0.0.1:${process.env.FDE_WEB_PORT ?? 1234}`,
    counts: {
      leads: leads.length, proposals: proposals.length, contracts: contracts.length,
      deliveries: deliveries.length, deployments: deployments.length,
      renewals: renewals.length, channels: channels.length, knowledge: knowledge.length,
    },
    leadsByStage,
    contractAmount: { total, byStatus },
    renewalsDue: { count: dueRenewals.length, amount: dueRenewals.reduce((s, r) => s + (Number(r?.amount) || 0), 0) },
    leads: pick(leads, 12).map(liteLead),
    proposals: pick(proposals, 12).map((x: any) => ({
      id: String(x.id), leadId: String(x.leadId ?? ""), title: String(x.title), createdAt: String(x.createdAt ?? ""),
      status: String(x.status ?? ""), version: Number(x.version) || 1, total: Number(x.total) || 0,
    })),
    contracts: pick(contracts, 12).map((x: any) => ({
      id: String(x.id), code: String(x.code ?? ""), customer: String(x.customer ?? ""),
      amount: Number(x.amount) || 0, status: String(x.status ?? ""), ...(x.signDate ? { signDate: String(x.signDate) } : {}),
    })),
    renewals: pick([...(renewals as any[])].sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))), 8).map((x: any) => ({
      id: String(x.id), customer: String(x.customer ?? ""), item: String(x.item ?? ""),
      dueDate: String(x.dueDate ?? ""), amount: Number(x.amount) || 0, status: String(x.status ?? ""),
    })),
    deliveries: pick(deliveries, 6).map((x: any) => ({
      id: String(x.id), customer: String(x.customer ?? ""), name: String(x.name ?? ""), status: String(x.status ?? ""),
    })),
    deployments: pick(deployments, 6).map((x: any) => ({
      id: String(x.id), customer: String(x.customer ?? ""), site: String(x.site ?? ""), status: String(x.status ?? ""),
    })),
    knowledge: pick(knowledge, 6).map((x: any) => ({
      id: String(x.id), title: String(x.title ?? ""), status: String(x.status ?? ""), date: String(x.date ?? ""),
    })),
  };
}

/** 方案 → doc-worker 块结构（与 fde-workbench proposalDoc.buildProposalDoc 同构） */
async function buildProposalDoc(ctx: SeamContext, proposalId: string): Promise<{ ok: boolean; filename?: string; base64?: string; bytes?: number; error?: string }> {
  const [proposals, leads, skus] = await Promise.all([
    readSlice("proposals"), readSlice("leads"), readSlice("skus"),
  ]);
  const p = (proposals as any[]).find((x) => String(x?.id) === proposalId) as ProposalDocShape | undefined;
  if (!p) return { ok: false, error: `方案不存在: ${proposalId}` };
  const lead = (leads as any[]).find((x) => String(x?.id) === String(p.leadId));

  type Block = { type: string; text?: string; level?: number; items?: string[]; header?: string[]; rows?: string[][] };
  const blocks: Block[] = [];
  for (const w of p.word ?? []) {
    blocks.push({ type: "heading", text: String(w.heading), level: 2 });
    blocks.push({ type: "paragraph", text: String(w.body) });
  }
  blocks.push({ type: "heading", text: "四、报价清单", level: 2 });
  blocks.push({
    type: "table",
    header: ["费用项", "说明", "金额（元）"],
    rows: (p.quote ?? []).map((l) => [String(l.item), String(l.desc), (Number(l.amount) || 0).toLocaleString()]),
  });
  const skuList = (p.skus ?? [])
    .map((id) => (skus as SkuShape[]).find((s) => s?.id === id))
    .filter((s): s is SkuShape => !!s);
  if (skuList.length > 0) {
    blocks.push({ type: "heading", text: "五、组装标准产品", level: 2 });
    blocks.push({
      type: "bullets",
      items: skuList.map((s) => `${s.name}（${s.spec}）：¥${(Number(s.price) || 0).toLocaleString()}/${s.unit} · ${s.billing}`),
    });
  }
  blocks.push({ type: "paragraph", text: `报价合计：¥${(Number(p.total) || 0).toLocaleString()}（含税）` });
  if ((p.caseRefs ?? []).length > 0) {
    blocks.push({ type: "heading", text: "附录 · 参考案例", level: 2 });
    blocks.push({
      type: "bullets",
      items: p.caseRefs.map((r) => `【${KIND_LABEL[r.kind]}】${r.title} —— ${r.reason}`),
    });
    blocks.push({ type: "paragraph", text: "以上案例由数字员工检索推荐、人工确认关联，作为本方案生成的上下文背景知识。" });
  }

  const doc = await ctx.call(
    { id: "@action/doc-worker", versionRange: "^1.0.0" },
    {
      title: String(p.title),
      subtitle: `客户：${lead?.name ?? "—"} · Aigility 智悦智能平台 · v${p.version} · ${p.createdAt}`,
      creator: "Aigility 智悦智能平台（FDE 生意台账应用包）",
      basename: `${p.title}_v${p.version}`,
      blocks,
    },
  ) as { ok: boolean; value?: { ok?: boolean; filename?: string; base64?: string; bytes?: number; error?: string }; error?: unknown };

  if (!doc.ok || !doc.value?.base64) {
    const msg = doc.value?.error ?? (doc.ok ? "doc-worker 未返回文件" : String(doc.error ?? "doc-worker 调用失败"));
    return { ok: false, error: String(msg) };
  }
  return { ok: true, filename: doc.value.filename, base64: doc.value.base64, bytes: doc.value.bytes };
}

// ── Provider 实现 ────────────────────────────────────────────────

const providerName = "action-fde-ledger";

export const fdeLedgerProvider: Provider<FdeLedgerRequest, unknown> = {
  service: fdeLedgerService,
  name: providerName,
  state: PluginState.Active,
  async execute(request: FdeLedgerRequest, ctx: SeamContext): Promise<Result<unknown>> {
    if (request.action === "proposal-doc") {
      if (!request.proposalId?.trim()) return ok({ ok: false, error: "proposalId 必填" });
      return ok(await buildProposalDoc(ctx, request.proposalId.trim()));
    }
    try {
      return ok(await buildSummary());
    } catch (err) {
      return ok({
        ok: false,
        error: `共库台账不可读（AppBase PG 未可达或 fde-workbench 未初始化）: ${String(err)}`,
        source: FDE_DATA_OWNER,
        seeded: false,
        fdeWorkbenchUrl: `http://127.0.0.1:${process.env.FDE_WEB_PORT ?? 1234}`,
        counts: {}, leadsByStage: {},
        contractAmount: { total: 0, byStatus: {} },
        renewalsDue: { count: 0, amount: 0 },
        leads: [], proposals: [], contracts: [], renewals: [], deliveries: [], deployments: [], knowledge: [],
      } satisfies FdeLedgerSummary);
    }
  },
  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: "fde-ledger ready", checkedAt: new Date().toISOString() };
  },
};

// ── 插件清单（示例本地 LayerPlugin, 随主装配注入 bootstrap） ──────

export const manifest: PluginManifest = {
  name: "@action/fde-ledger",
  layer: LayerId.Action,
  description: "行动执行层：FDE 生意台账域包（共库台账总览 + 方案 DOCX 导出），插入智悦的 fde-workbench 核心资产",
  version: "1.0.0",
  provides: [fdeLedgerService],
  consumes: [{ id: "@action/doc-worker", versionRange: "^1.0.0" }],
  preferredCarrier: CarrierKind.Thread,
};

export const fdeLedgerPlugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [fdeLedgerProvider];
  },
  getState(): PluginState {
    return PluginState.Active;
  },
};
