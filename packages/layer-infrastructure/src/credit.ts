/**
 * L1 底座基础层: 积分账务 (credit)
 *
 * 积分是人民币与 token 之间的计价中介, 对齐市面惯例:
 *   - 固定汇率: 1 元 = creditPerYuan 积分 (默认 100), 用户只看积分;
 *   - 模型倍率: 消耗 = 基准价(积分/1M 输入 token) × 模型倍率,
 *     输出单价 = 输入单价 × outputFactor (默认 4, 对齐主流平台 in:out ≈ 1:4);
 *   - 预检 + 实扣: 调用前按估算余额预检(不足拒绝), 调用后按实测 usage 实扣
 *     (允许小额透支, 对齐"最后一条放行"惯例);
 *   - 新账户赠送 newUserGrant 积分(注册赠送惯例);
 *   - 全量流水: grant/recharge/consume/adjust 每笔留痕, 带扣后余额快照。
 *
 * 存储: 默认内存账本(零依赖原型); 装配方经 configureCreditStore({pool}) 接
 * PostgreSQL(钱必须持久, 扣减用原子 UPDATE ... RETURNING)。
 * 计费入口: token-metering 收到 attribution="user" 的用量记录后转发 consume;
 * 调用方在 LlmInferenceRequest.userId 带身份是计费前提(仅按 session 归因不扣费)。
 */

import pg from "pg";
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
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 定价配置与汇率 ───────────────────────────────────────────────

export interface CreditPricingConfig {
  /** 人民币汇率: 1 元 = creditPerYuan 积分 (默认 100) */
  creditPerYuan: number;
  /** 基准价: 积分 / 1M 输入 token (倍率 1 的模型; 默认 200 = ¥2/M) */
  baseCreditsPerMTok: number;
  /** 输出单价 = 输入单价 × outputFactor (默认 4) */
  outputFactor: number;
  /** 价目表外模型的默认倍率 (默认 1) */
  defaultMultiplier: number;
  /** 新账户赠送积分 (默认 1000 = ¥10) */
  newUserGrant: number;
  /** 模型倍率表: 数字 = 倍率; 对象可另覆写 outputFactor */
  modelMultipliers: Record<string, number | { multiplier?: number; outputFactor?: number }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PRICING: CreditPricingConfig = {
  creditPerYuan: 100,
  baseCreditsPerMTok: 200,
  outputFactor: 4,
  defaultMultiplier: 1,
  newUserGrant: 1000,
  modelMultipliers: {
    "glm-4.6": 1,
    "glm-4.5": 1,
    "glm-4.5-air": 0.2,
    "glm-4-flash": 0.1,
    "deepseek-chat": 0.5,
    "deepseek-reasoner": 1,
    // stub 无真实成本: 象征性倍率, 让计量/扣费链路在零依赖模式下可见
    "stub-llm@0.1.0": 0.1,
  },
};

function readPricingFileConfig(): Partial<CreditPricingConfig> {
  // src/tsx 运行时: packages/layer-infrastructure/src → ../../../config/default.json
  // 编译后 dist 运行时: packages/layer-infrastructure/dist → ../../config/default.json
  const candidates = [
    resolve(__dirname, "../../../config/default.json"),
    resolve(__dirname, "../../config/default.json"),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as { credits?: Partial<CreditPricingConfig> };
      return parsed.credits ?? {};
    } catch {
      // 文件不存在或 JSON 非法 → 试下一个候选
    }
  }
  return {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 解析生效定价: env > config/default.json#credits > 内置默认 */
export function resolveCreditPricing(): CreditPricingConfig {
  const file = readPricingFileConfig();
  const env = process.env;
  return {
    creditPerYuan: num(env.CREDIT_PER_YUAN, num(file.creditPerYuan, DEFAULT_PRICING.creditPerYuan)),
    baseCreditsPerMTok: num(env.CREDIT_BASE_PER_MTOK, num(file.baseCreditsPerMTok, DEFAULT_PRICING.baseCreditsPerMTok)),
    outputFactor: num(env.CREDIT_OUTPUT_FACTOR, num(file.outputFactor, DEFAULT_PRICING.outputFactor)),
    defaultMultiplier: num(file.defaultMultiplier, DEFAULT_PRICING.defaultMultiplier),
    newUserGrant: num(env.CREDIT_NEW_USER_GRANT, num(file.newUserGrant, DEFAULT_PRICING.newUserGrant)),
    modelMultipliers: { ...DEFAULT_PRICING.modelMultipliers, ...(file.modelMultipliers ?? {}) },
  };
}

/** 生效定价 (进程内共享; 装配方也可直接 import 展示) */
export const creditPricing = resolveCreditPricing();

export interface PricedUsage {
  /** 本次消耗积分 (2 位小数) */
  credits: number;
  /** 生效模型倍率 */
  multiplier: number;
  /** 生效输出系数 */
  outputFactor: number;
}

/** 定价引擎: 积分 = (输入×倍率 + 输出×倍率×输出系数) / 1M × 基准价, 保留 2 位小数 */
export function computeCredits(
  pricing: CreditPricingConfig,
  model: string,
  promptTokens: number,
  completionTokens: number,
): PricedUsage {
  const entry = pricing.modelMultipliers[model];
  const multiplier =
    typeof entry === "number" ? entry : (entry?.multiplier ?? pricing.defaultMultiplier);
  const of =
    (typeof entry === "object" && entry?.outputFactor !== undefined
      ? entry.outputFactor
      : pricing.outputFactor);
  const raw =
    ((promptTokens * multiplier + completionTokens * multiplier * of) / 1_000_000) *
    pricing.baseCreditsPerMTok;
  return { credits: Math.round(raw * 100) / 100, multiplier, outputFactor: of };
}

/** 单模型价目 (积分/1M token, 供价目表展示) */
export function modelRates(pricing: CreditPricingConfig, model: string): { input: number; output: number; multiplier: number; outputFactor: number } {
  const p = computeCredits(pricing, model, 1_000_000, 0);
  const po = computeCredits(pricing, model, 0, 1_000_000);
  return { input: p.credits, output: po.credits, multiplier: p.multiplier, outputFactor: p.outputFactor };
}

// ── 账本存储 (memory 默认 / pg 可换装) ───────────────────────────

export type CreditTxType = "grant" | "recharge" | "consume" | "adjust";

export interface CreditTx {
  id: string;
  at: string;
  userId: string;
  type: CreditTxType;
  /** 本笔变动 ( consume 为负) */
  credits: number;
  /** 扣后余额快照 */
  balanceAfter: number;
  model?: string;
  note?: string;
  traceId?: string;
}

export interface CreditAccount {
  userId: string;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreditAdjustMeta {
  type: CreditTxType;
  model?: string;
  note?: string;
  traceId?: string;
}

export interface CreditStore {
  readonly kind: "memory" | "pg";
  /**
   * 变动余额并落流水。账户不存在时先按 newUserGrant 建账(写 grant 流水)
   * 再执行本笔变动 —— 即首笔消费吃注册赠送额度。
   */
  adjust(userId: string, delta: number, meta: CreditAdjustMeta): Promise<{ balanceAfter: number; newAccount: boolean }>;
  /** 余额; null = 尚无账户 */
  getBalance(userId: string): Promise<number | null>;
  listAccounts(limit?: number): Promise<CreditAccount[]>;
  listTx(opts?: { userId?: string; limit?: number }): Promise<CreditTx[]>;
}

export function createMemoryCreditStore(newUserGrant = creditPricing.newUserGrant): CreditStore {
  const accounts = new Map<string, CreditAccount>();
  const txs: CreditTx[] = [];
  const store: CreditStore = {
    kind: "memory",
    async adjust(userId, delta, meta) {
      const now = new Date().toISOString();
      let acc = accounts.get(userId);
      let newAccount = false;
      if (!acc) {
        acc = { userId, balance: newUserGrant, createdAt: now, updatedAt: now };
        accounts.set(userId, acc);
        newAccount = true;
        txs.push({
          id: crypto.randomUUID(), at: now, userId,
          type: "grant", credits: newUserGrant, balanceAfter: newUserGrant,
          note: "注册赠送",
        });
      }
      acc.balance = Math.round((acc.balance + delta) * 100) / 100;
      acc.updatedAt = now;
      txs.push({
        id: crypto.randomUUID(), at: now, userId,
        type: meta.type, credits: delta, balanceAfter: acc.balance,
        model: meta.model, note: meta.note, traceId: meta.traceId,
      });
      return { balanceAfter: acc.balance, newAccount };
    },
    async getBalance(userId) {
      return accounts.get(userId)?.balance ?? null;
    },
    async listAccounts(limit = 100) {
      return [...accounts.values()]
        .sort((a, b) => b.balance - a.balance)
        .slice(0, limit);
    },
    async listTx(opts = {}) {
      let list = txs;
      if (opts.userId) list = list.filter((t) => t.userId === opts.userId);
      return list.slice(-(opts.limit ?? 100)).reverse();
    },
  };
  return store;
}

// ── PG 建表 SQL ──────────────────────────────────────────────────

/** CREATE TABLE IF NOT EXISTS (账户 + 流水两表) */
export function creditSetupSql(prefix: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}_account (
      user_id    TEXT PRIMARY KEY,
      balance    NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ${prefix}_tx (
      id            TEXT PRIMARY KEY,
      at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id       TEXT NOT NULL,
      type          TEXT NOT NULL,
      credits       NUMERIC(14,2) NOT NULL,
      balance_after NUMERIC(14,2) NOT NULL,
      model         TEXT,
      note          TEXT,
      trace_id      TEXT
    );
    CREATE INDEX IF NOT EXISTS ${prefix}_tx_user_idx ON ${prefix}_tx (user_id, at DESC);
  `;
}

export interface PgCreditStoreOptions {
  /** PostgreSQL 连接串; 缺省用环境变量 DATABASE_URL */
  connectionString?: string;
  /** 共享连接池 (多组件复用一个池时传入, 否则实例自建) */
  pool?: pg.Pool;
  /** 表前缀 (默认 aigility_credit) */
  tablePrefix?: string;
  /** 新账户赠送积分 (默认取生效定价) */
  newUserGrant?: number;
}

export function createPgCreditStore(opts: PgCreditStoreOptions): CreditStore {
  const prefix = opts.tablePrefix ?? "aigility_credit";
  const ownPool = !opts.pool;
  const pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString ?? process.env.DATABASE_URL });
  const grant = opts.newUserGrant ?? creditPricing.newUserGrant;
  let setupPromise: Promise<void> | null = null;
  const setup = (): Promise<void> => {
    setupPromise ??= pool.query(creditSetupSql(prefix)).then(() => undefined);
    return setupPromise;
  };

  const rowToTx = (r: any): CreditTx => ({
    id: String(r.id),
    at: new Date(r.at).toISOString(),
    userId: r.user_id,
    type: r.type as CreditTxType,
    credits: Number(r.credits),
    balanceAfter: Number(r.balance_after),
    model: r.model ?? undefined,
    note: r.note ?? undefined,
    traceId: r.trace_id ?? undefined,
  });

  return {
    kind: "pg",
    async adjust(userId, delta, meta) {
      await setup();
      // 原子 upsert: 新账户初始余额 = 赠送 + delta; 旧账户 = balance + delta。
      // xmax = 0 区分本次插入 (Postgres 惯用法)。
      const { rows } = await pool.query(
        `INSERT INTO ${prefix}_account (user_id, balance)
         VALUES ($1, $2::numeric + $3::numeric)
         ON CONFLICT (user_id) DO UPDATE
           SET balance = ${prefix}_account.balance + $3::numeric, updated_at = now()
         RETURNING balance, (xmax = 0) AS inserted`,
        [userId, grant, delta],
      );
      const balanceAfter = Math.round(Number(rows[0].balance) * 100) / 100;
      const inserted = Boolean(rows[0].inserted);
      const now = new Date().toISOString();
      const txs: CreditTx[] = [];
      if (inserted) {
        txs.push({
          id: crypto.randomUUID(), at: now, userId,
          type: "grant", credits: grant, balanceAfter: grant,
          note: "注册赠送",
        });
      }
      txs.push({
        id: crypto.randomUUID(), at: now, userId,
        type: meta.type, credits: delta, balanceAfter,
        model: meta.model, note: meta.note, traceId: meta.traceId,
      });
      for (const t of txs) {
        await pool.query(
          `INSERT INTO ${prefix}_tx (id, at, user_id, type, credits, balance_after, model, note, trace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [t.id, t.at, t.userId, t.type, t.credits, t.balanceAfter, t.model ?? null, t.note ?? null, t.traceId ?? null],
        );
      }
      return { balanceAfter, newAccount: inserted };
    },
    async getBalance(userId) {
      await setup();
      const { rows } = await pool.query(
        `SELECT balance FROM ${prefix}_account WHERE user_id = $1`,
        [userId],
      );
      return rows.length ? Number(rows[0].balance) : null;
    },
    async listAccounts(limit = 100) {
      await setup();
      const { rows } = await pool.query(
        `SELECT user_id, balance, created_at, updated_at FROM ${prefix}_account ORDER BY balance DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r: any) => ({
        userId: r.user_id,
        balance: Number(r.balance),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
    },
    async listTx(listOpts = {}) {
      await setup();
      const limit = listOpts.limit ?? 100;
      const { rows } = listOpts.userId
        ? await pool.query(
            `SELECT * FROM ${prefix}_tx WHERE user_id = $1 ORDER BY at DESC LIMIT $2`,
            [listOpts.userId, limit],
          )
        : await pool.query(
            `SELECT * FROM ${prefix}_tx ORDER BY at DESC LIMIT $1`,
            [limit],
          );
      return rows.map(rowToTx);
    },
  };
}

// ── 共享账本 (可换装) ────────────────────────────────────────────

/**
 * 进程内共享账本: 默认内存实现; 装配方 (如 appbase 启动时) 经
 * configureCreditStore({pool}) 换成 PG 实现 —— 余额与流水必须持久。
 * 必须在首笔扣费前调用; 换装不迁移内存数据。
 */
let sharedStore: CreditStore = createMemoryCreditStore();

export function configureCreditStore(opts: PgCreditStoreOptions | { memory: true }): void {
  sharedStore = "memory" in opts ? createMemoryCreditStore() : createPgCreditStore(opts);
}

export function getCreditStore(): CreditStore {
  return sharedStore;
}

/** 兼容导出: 直接 import 读账本 (与 sharedUsageLedger 同款约定) */
export const sharedCreditStore = {
  get kind(): "memory" | "pg" {
    return sharedStore.kind;
  },
  adjust: (u: string, d: number, m: CreditAdjustMeta) => sharedStore.adjust(u, d, m),
  getBalance: (u: string) => sharedStore.getBalance(u),
  listAccounts: (l?: number) => sharedStore.listAccounts(l),
  listTx: (o?: { userId?: string; limit?: number }) => sharedStore.listTx(o),
};

// ── 服务定义 (插件形态, ctx.call 使用) ───────────────────────────

export interface CreditRequest {
  action:
    | "check"        // 余额预检: 估算消耗 vs 余额
    | "consume"      // 实扣: 按实测 usage 定价扣减
    | "balance"      // 查余额
    | "grant"        // 充值/赠送/调整 (管理员)
    | "accounts"     // 账户列表 (管理员)
    | "transactions" // 流水查询
    | "pricing";     // 汇率与价目
  userId?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 预检/实扣附带的归因上下文 */
  sessionId?: string;
  traceId?: string;
  source?: "measured" | "estimated";
  provider?: string;
  /** grant: 变动积分数 (可负) */
  credits?: number;
  note?: string;
  limit?: number;
}

export interface CreditResponse {
  allowed?: boolean;
  balance?: number;
  estCredits?: number;
  chargedCredits?: number;
  balanceAfter?: number;
  pricing?: CreditPricingConfig & {
    models: Array<{ model: string; multiplier: number; outputFactor: number; input: number; output: number }>;
  };
  accounts?: CreditAccount[];
  transactions?: CreditTx[];
  total?: number;
}

export const creditService: ServiceDefinition<CreditRequest, CreditResponse> = {
  id: "@infrastructure/credit",
  version: "1.0.0",
  layer: LayerId.Infrastructure,
  description:
    "积分账务：人民币↔token 计价中介（固定汇率 + 模型倍率 + 预检实扣 + 全量流水）",
};

const creditProvider: Provider<CreditRequest, CreditResponse> = {
  service: creditService,
  name: "infrastructure-credit",
  state: PluginState.Active,
  async execute(
    request: CreditRequest,
    ctx: SeamContext,
  ): Promise<Result<CreditResponse>> {
    switch (request.action) {
      case "check": {
        const userId = request.userId ?? "";
        if (!userId) return ok({ allowed: true });
        const model = request.model ?? "";
        const est = computeCredits(
          creditPricing,
          model,
          request.promptTokens ?? 0,
          request.completionTokens ?? 0,
        );
        if (est.credits <= 0) return ok({ allowed: true, balance: await sharedStore.getBalance(userId) ?? creditPricing.newUserGrant, estCredits: 0 });
        const balance = (await sharedStore.getBalance(userId)) ?? creditPricing.newUserGrant;
        return ok({ allowed: balance >= est.credits, balance, estCredits: est.credits });
      }
      case "consume": {
        const userId = request.userId ?? "";
        if (!userId) return ok({ chargedCredits: 0 });
        const model = request.model ?? "";
        const est = computeCredits(
          creditPricing,
          model,
          request.promptTokens ?? 0,
          request.completionTokens ?? 0,
        );
        if (est.credits <= 0) {
          // 免费模型 (倍率 0): 不建账不扣费
          return ok({ chargedCredits: 0, balanceAfter: await sharedStore.getBalance(userId) ?? 0 });
        }
        const { balanceAfter } = await sharedStore.adjust(userId, -est.credits, {
          type: "consume",
          model: `${model}${request.source === "estimated" ? "(est)" : ""}`,
          note: request.provider ? `LLM 调用 (${request.provider})` : "LLM 调用",
          traceId: request.traceId ?? ctx.traceId,
        });
        return ok({ chargedCredits: est.credits, balanceAfter });
      }
      case "balance": {
        if (!request.userId) return ok({});
        return ok({
          balance: await sharedStore.getBalance(request.userId) ?? creditPricing.newUserGrant,
        });
      }
      case "grant": {
        if (!request.userId || typeof request.credits !== "number" || request.credits === 0) {
          return ok({});
        }
        const { balanceAfter } = await sharedStore.adjust(request.userId, request.credits, {
          type: request.credits > 0 ? "recharge" : "adjust",
          note: request.note ?? "管理员操作",
          traceId: ctx.traceId,
        });
        return ok({ balanceAfter });
      }
      case "accounts": {
        return ok({ accounts: await sharedStore.listAccounts(request.limit ?? 100) });
      }
      case "transactions": {
        const txs = await sharedStore.listTx({ userId: request.userId, limit: request.limit ?? 100 });
        return ok({ transactions: txs, total: txs.length });
      }
      case "pricing": {
        const models = Object.entries(creditPricing.modelMultipliers).map(([m]) => ({
          model: m,
          ...modelRates(creditPricing, m),
        }));
        return ok({ pricing: { ...creditPricing, models } });
      }
      default:
        return ok({});
    }
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: `credit store: ${sharedStore.kind}`,
      checkedAt: new Date().toISOString(),
    };
  },
};

export { creditProvider };

// ── 插件 Manifest 片段 (并入 @infrastructure 主插件) ─────────────

export const creditManifest: PluginManifest = {
  name: "@infrastructure/credit",
  layer: LayerId.Infrastructure,
  description: "底座基础层：积分账务（汇率/倍率定价 + 预检实扣 + 流水）",
  version: "0.1.0",
  provides: [creditService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
