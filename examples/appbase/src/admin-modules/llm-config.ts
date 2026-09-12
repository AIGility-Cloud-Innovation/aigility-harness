/**
 * Admin module: llm-config — 全局 LLM 平台配置 (认知层 LLM 上游 + AI 网关上游)
 * 从 backend.ts 迁出 (管理界面插件化)。数据复用 app_llm_config 表,
 * 平台行用 "platform:" 前缀与 app_id 区隔。
 */
import { updateModelsUpstream } from "@aigility-harness/layer-infrastructure";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody, pool, verifyToken, isAdminUser, writeAudit, emailOf } from "./context.js";

// ── 全局 LLM 配置 (复用 app_llm_config, 平台行用 "platform:" 前缀与 app_id 区隔) ──

const PLATFORM_PREFIX = "platform:";

/** 掩码回显: 永不把明文 Key 返给前端 */
function maskKey(key: string): string {
  return key ? "••••" + key.slice(-4) : "";
}

/**
 * 把激活平台应用到运行时: 写 env(认知层每调用读 env, 天然热生效)
 * + 热更新 AI 网关上游(updateModelsUpstream), 无需重启。
 * 统一走 bigmodel 直连适配({base}/chat/completions, OpenAI 兼容平台通用)。
 */
function applyLlmToRuntime(row: { url?: string; key?: string; model?: string }): void {
  if (row.url) process.env.BIGMODEL_BASE_URL = row.url;
  if (row.key) process.env.BIGMODEL_API_KEY = row.key;
  if (row.model) process.env.LLM_MODEL = row.model;
  process.env.LLM_PROVIDER = "bigmodel";
  updateModelsUpstream({ url: row.url ?? "", key: row.key ?? "" });
  console.log(`[llm-global] 已热应用平台配置: url=${row.url ?? "(未变)"} model=${row.model ?? "(未变)"}`);
}

/** 切换激活平台并热生效 */
async function activateLlmPlatform(userId: string, platform: string): Promise<boolean> {
  const id = PLATFORM_PREFIX + platform;
  const { rows } = await pool.query(
    "SELECT url, key, model FROM app_llm_config WHERE app_id = $1", [id]);
  if (rows.length === 0) return false;
  await pool.query("UPDATE app_llm_config SET is_active = false WHERE app_id LIKE 'platform:%'");
  await pool.query("UPDATE app_llm_config SET is_active = true, updated_at = now() WHERE app_id = $1", [id]);
  applyLlmToRuntime(rows[0]);
  void writeAudit(await emailOf(userId), "llm_global.activate", platform);
  return true;
}

/** 启动衔接: 读激活平台写 env + 网关上游(由 index.ts 在网关启动前调用); 无激活行返回 null */
export async function loadActiveLlmConfig(): Promise<{ url: string; key: string; model: string } | null> {
  try {
    const { rows } = await pool.query(
      "SELECT url, key, model FROM app_llm_config WHERE app_id LIKE 'platform:%' AND is_active = true");
    if (rows.length === 0) return null;
    applyLlmToRuntime(rows[0]);
    return { url: rows[0].url ?? "", key: rows[0].key ?? "", model: rows[0].model ?? "" };
  } catch (e) {
    console.error("[llm-global] loadActiveLlmConfig failed (忽略, 走 env 兜底):", e);
    return null;
  }
}

export function normalizeLlmBase(url: string): string {
  let u = url.trim().replace(/\/$/, "");
  if (u.toLowerCase().endsWith("/chat/completions")) u = u.slice(0, -"/chat/completions".length);
  return u;
}

/** 启动种子与应用 (backend.initAppBackend 调用) */
export async function initLlmConfig(): Promise<void> {
  try {
    const { rows } = await pool.query(
      "SELECT app_id FROM app_llm_config WHERE app_id LIKE 'platform:%'");
    if (rows.length === 0 && (process.env.BIGMODEL_API_KEY ?? "")) {
      await pool.query(
        `INSERT INTO app_llm_config (app_id, url, key, model, env, is_active, updated_at)
         VALUES ('platform:智谱', $1, $2, $3, '{}'::jsonb, true, now())
         ON CONFLICT (app_id) DO NOTHING`,
        [process.env.BIGMODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
         process.env.BIGMODEL_API_KEY ?? "",
         process.env.LLM_MODEL ?? "glm-4.6"]);
      console.log("[llm-global] 已从 env 种子默认平台配置(智谱)");
    }
    await loadActiveLlmConfig();
  } catch (e) {
    console.error("[llm-global] 启动种子/应用失败(忽略):", e);
  }
}

/** llm-global 路由处理; 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!path.startsWith("/app/hall/llm-global")) return false;
    // 响应追踪: 块内 return json(...) 只退出 IIFE, 由"是否已 writeHead"判定 handled
    let responded = false;
    const __wh = res.writeHead.bind(res);
    (res as unknown as { writeHead: unknown }).writeHead = (...a: unknown[]) => {
      responded = true;
      return (__wh as (...a2: unknown[]) => ServerResponse)(...a);
    };
  try {
    await (async () => {
    // ── 全局 LLM 平台配置 (仅管理员; 数据在 app_llm_config 的 platform: 前缀行) ──
    if (path.startsWith("/app/hall/llm-global")) {
      const auth = req.headers.authorization ?? "";
      const userId = auth.startsWith("Bearer ") ? verifyToken(auth.slice(7)) : null;
      if (!userId) return json(res, 401, { error: "未授权: 先登录" });
      if (!(await isAdminUser(userId))) return json(res, 403, { error: "仅管理员可管理全局 LLM 配置" });

      // 列表 (Key 只回掩码)
      if (method === "GET" && path === "/app/hall/llm-global") {
        const { rows } = await pool.query(
          `SELECT app_id, url, key, model, is_active, updated_at FROM app_llm_config
           WHERE app_id LIKE 'platform:%' ORDER BY is_active DESC, updated_at DESC`);
        return json(res, 200, {
          platforms: rows.map((r: any) => ({
            platform: String(r.app_id).slice(PLATFORM_PREFIX.length),
            base_url: r.url ?? "",
            model: r.model ?? "",
            key_masked: maskKey(r.key ?? ""),
            has_key: !!(r.key ?? ""),
            is_active: !!r.is_active,
            updated_at: r.updated_at,
          })),
          active_platform: String(rows.find((r: any) => r.is_active)?.app_id ?? "").slice(PLATFORM_PREFIX.length),
        });
      }

      // 保存平台 (upsert; api_key 空串或掩码开头 = 保持原值)
      if (method === "PUT" && path === "/app/hall/llm-global") {
        const body = await readBody(req);
        const platform = String(body.platform ?? "").trim();
        if (!platform || platform.length > 40 || platform.includes("/")) {
          return json(res, 400, { error: "platform 名称不合法" });
        }
        const id = PLATFORM_PREFIX + platform;
        const { rows: existing } = await pool.query(
          "SELECT url, key, model FROM app_llm_config WHERE app_id = $1", [id]);
        const prev = existing[0] ?? { url: "", key: "", model: "" };
        const url = body.base_url !== undefined ? String(body.base_url).trim() : prev.url;
        const incomingKey = body.api_key !== undefined ? String(body.api_key) : undefined;
        const key = incomingKey !== undefined && incomingKey !== "" && !incomingKey.startsWith("••••")
          ? incomingKey : prev.key;
        const model = body.model !== undefined ? String(body.model).trim() : prev.model;
        await pool.query(
          `INSERT INTO app_llm_config (app_id, url, key, model, env, is_active, updated_at)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, false, now())
           ON CONFLICT (app_id) DO UPDATE SET url=$2, key=$3, model=$4, updated_at=now()`,
          [id, url, key, model]);
        const changed = [
          body.base_url !== undefined ? "url" : null,
          incomingKey !== undefined && incomingKey !== "" && !incomingKey.startsWith("••••") ? "key" : null,
          body.model !== undefined ? "model" : null,
        ].filter(Boolean).join("/") || "(空保存)";
        void writeAudit(await emailOf(userId), "llm_global.save", platform, changed);
        let activePlatform = "";
        if (body.activate || existing.length === 0) {
          await activateLlmPlatform(userId, platform);
        }
        const { rows: act } = await pool.query(
          "SELECT app_id FROM app_llm_config WHERE app_id LIKE 'platform:%' AND is_active = true");
        activePlatform = String(act[0]?.app_id ?? "").slice(PLATFORM_PREFIX.length);
        return json(res, 200, { ok: true, active_platform: activePlatform });
      }

      // 切换激活 (热生效)
      if (method === "POST" && path === "/app/hall/llm-global/activate") {
        const body = await readBody(req);
        const platform = String(body.platform ?? "").trim();
        const okActivate = await activateLlmPlatform(userId, platform);
        if (!okActivate) return json(res, 404, { error: "平台不存在: " + platform });
        return json(res, 200, { ok: true, active_platform: platform });
      }

      // 删除平台
      const delMatch = path.match(/^\/app\/hall\/llm-global\/([^/]+)$/);
      if (method === "DELETE" && delMatch) {
        const platform = decodeURIComponent(delMatch[1]);
        const { rowCount } = await pool.query(
          "DELETE FROM app_llm_config WHERE app_id = $1", [PLATFORM_PREFIX + platform]);
        if (rowCount === 0) return json(res, 404, { error: "平台不存在: " + platform });
        void writeAudit(await emailOf(userId), "llm_global.delete", platform);
        return json(res, 200, { ok: true });
      }

          if (responded) return true;
    return json(res, 404, { error: "llm-global: not found" });
    }
    })();

  } catch (e) {
    json(res, 500, { error: String((e as Error)?.message ?? e) });
    return true;
  }
  return true;
}
