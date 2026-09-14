/**
 * Admin module: dsh-plugins — DSH(cordis) 插件管理
 * 从 backend.ts 迁出 (管理界面插件化)。宿主见 ../dsh-host.ts。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { dshLoadPlugin, dshLoadEnabled, dshStatus } from "../dsh-host.js";
import { dshBaseRows, dshSuiteVersions, isJsExpr } from "@aigility-harness/dsh-interop";
import { json, readBody, pool, bearerUser, isAdminUser, writeAudit, emailOf, parseEnvText } from "./context.js";

/** 把 config 里的 JsExpr 原文渲染成 js(...) 字符串 (供展示, 不求值) */
function renderConfig(v: unknown): unknown {
  if (isJsExpr(v)) return `js(${v.__jsExpr})`;
  if (Array.isArray(v)) return v.map(renderConfig);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderConfig(x)]));
  }
  return v ?? null;
}

/** dsh 路由处理; 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!path.startsWith("/app/dsh/")) return false;
    // 响应追踪: 块内 return json(...) 只退出 IIFE, 由"是否已 writeHead"判定 handled
    let responded = false;
    const __wh = res.writeHead.bind(res);
    (res as unknown as { writeHead: unknown }).writeHead = (...a: unknown[]) => {
      responded = true;
      return (__wh as (...a2: unknown[]) => ServerResponse)(...a);
    };
  try {
    await (async () => {
    // ── 管理员: 官方能力目录 (dsh-base patch 行清单, 只读展示, 不求值) ──
    if (method === "GET" && path === "/app/dsh/catalog") {
      const adminId = bearerUser(req);
      if (!adminId) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(adminId))) return json(res, 403, { error: "需要管理员权限" });
      const rows = dshBaseRows().map((r) => ({
        id: r.id ?? null,
        name: r.name,
        disabled: r.disabled ?? false,
        // js(...) 原文条件 / 静态禁用都算「不默认启用」展示态
        disabledText: isJsExpr(r.disabled) ? `js(${r.disabled.__jsExpr})` : r.disabled === true ? "默认禁用" : null,
        notes: (r.notes ?? "").length > 300 ? (r.notes ?? "").slice(0, 300) + "…" : (r.notes ?? ""),
        config: renderConfig(r.config ?? null),
      }));
      return json(res, 200, { versions: dshSuiteVersions(), total: rows.length, rows });
    }

    // ── 管理员: DSH 插件管理 (cordis 插件注册/配置/加载) ──
    if (path.startsWith("/app/dsh/plugins")) {
      const adminId = bearerUser(req);
      if (!adminId) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(adminId))) return json(res, 403, { error: "需要管理员权限" });
      const adminEmail = await emailOf(adminId);

      // 机密配置项 (apikey/token/...) 回给前端时掩码; 保存时值为 •••• 开头 = 保持不变
      const SECRET_RE = /key|secret|token|password/i;
      const maskConfig = (cfg: Record<string, unknown>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg ?? {})) {
          const s = String(v ?? "");
          out[k] = SECRET_RE.test(k) ? (s ? "••••" + s.slice(-4) : "") : s;
        }
        return out;
      };

      if (method === "GET" && path === "/app/dsh/plugins") {
        const { rows } = await pool.query(
          "SELECT name, package, export_name, description, enabled, config FROM dsh_plugins ORDER BY name");
        return json(res, 200, {
          plugins: rows.map((r) => ({ ...r, config: maskConfig(r.config ?? {}) })),
          runtime: dshStatus(),
        });
      }

      // 注册新插件
      if (method === "POST" && path === "/app/dsh/plugins") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        const pkg = String(body.package ?? "").trim();
        if (!name || !pkg) return json(res, 400, { error: "name 和 package 必填" });
        try {
          await pool.query(
            `INSERT INTO dsh_plugins (name, package, export_name, description, config)
             VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [name, pkg, String(body.exportName ?? "").trim(), String(body.description ?? "").trim(),
             JSON.stringify(body.config ?? {})]);
        } catch (e: any) {
          if (String(e?.code) === "23505") return json(res, 409, { error: "同名插件已存在" });
          throw e;
        }
        void writeAudit(adminEmail, "dsh.plugin_register", name, pkg);
        return json(res, 201, { ok: true });
      }

      const dshMatch = path.match(/^\/app\/dsh\/plugins\/([^/]+)$/);
      const dshAction = path.match(/^\/app\/dsh\/plugins\/([^/]+)\/(load|unload)$/);
      if (dshMatch || dshAction) {
        const name = decodeURIComponent((dshAction ?? dshMatch)![1]);

        const fetchRec = async () => {
          const { rows } = await pool.query(
            "SELECT name, package, export_name, description, enabled, config FROM dsh_plugins WHERE name = $1",
            [name]);
          return rows[0];
        };

        // 启用/停用 + 保存配置
        if (method === "PUT" && dshMatch) {
          const rec = await fetchRec();
          if (!rec) return json(res, 404, { error: "插件不存在" });
          const body = await readBody(req);
          const enabled = body.enabled !== undefined ? Boolean(body.enabled) : rec.enabled;
          let config = rec.config ?? {};
          if (typeof body.configText === "string") {
            const parsed = parseEnvText(body.configText);
            const merged: Record<string, unknown> = { ...config };
            for (const [k, v] of Object.entries(parsed)) {
              // 掩码值 (•••• 开头) = 保持原值不变
              merged[k] = v.startsWith("••••") ? merged[k] ?? "" : v;
            }
            config = merged;
          }
          await pool.query(
            "UPDATE dsh_plugins SET enabled = $2, config = $3::jsonb, updated_at = now() WHERE name = $1",
            [name, enabled, JSON.stringify(config)]);
          // timem 配置热生效: 原地更新认知层读取的环境变量 (无需重启)
          if (name === "timem") {
            if (config.apiKey) process.env.TIMEM_API_KEY = String(config.apiKey);
            if (config.baseUrl) process.env.TIMEM_BASE_URL = String(config.baseUrl);
            if (config.defaultDomain) process.env.TIMEM_DEFAULT_DOMAIN = String(config.defaultDomain);
          }
          void writeAudit(adminEmail, "dsh.plugin_config", name,
            [body.enabled !== undefined ? `enabled=${enabled}` : null, body.configText !== undefined ? "配置已保存" : null]
              .filter(Boolean).join(", "));
          return json(res, 200, { ok: true });
        }

        // 加载 (手动; 未启用的也可以手动试载)
        if (method === "POST" && dshAction && dshAction[2] === "load") {
          const rec = await fetchRec();
          if (!rec) return json(res, 404, { error: "插件不存在" });
          const result = await dshLoadPlugin({
            name: rec.name, package: rec.package, export_name: rec.export_name, config: rec.config ?? {},
          });
          void writeAudit(adminEmail, "dsh.plugin_load", name, result.ok ? "加载成功" : `失败: ${result.error}`);
          return json(res, result.ok ? 200 : 500, result);
        }

        // 停用 = 重建宿主, 只加载其余启用的插件
        if (method === "POST" && dshAction && dshAction[2] === "unload") {
          const { rows } = await pool.query(
            "SELECT name, package, export_name, config FROM dsh_plugins WHERE enabled = true AND name <> $1",
            [name]);
          const results = await dshLoadEnabled(rows.map((r) => ({
            name: r.name, package: r.package, export_name: r.export_name, config: r.config ?? {},
          })));
          void writeAudit(adminEmail, "dsh.plugin_unload", name);
          return json(res, 200, { ok: true, reloaded: results });
        }
      }

      const dshDel = path.match(/^\/app\/dsh\/plugins\/([^/]+)$/);
      if (method === "DELETE" && dshDel) {
        const name = decodeURIComponent(dshDel[1]);
        await pool.query("DELETE FROM dsh_plugins WHERE name = $1", [name]);
        const { rows } = await pool.query(
          "SELECT name, package, export_name, config FROM dsh_plugins WHERE enabled = true");
        await dshLoadEnabled(rows.map((r) => ({
          name: r.name, package: r.package, export_name: r.export_name, config: r.config ?? {},
        })));
        void writeAudit(adminEmail, "dsh.plugin_delete", name);
        return json(res, 200, { ok: true });
      }

          if (responded) return true;
    return json(res, 404, { error: "dsh: not found" });
    }
        if (responded) return true;
    return json(res, 404, { error: "dsh: not found" });
    })();

  } catch (e) {
    json(res, 500, { error: String((e as Error)?.message ?? e) });
    return true;
  }
  return true;
}
