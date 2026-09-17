/**
 * Admin module: users — 账号域 (注册/登录/token/用户管理/审计/应用内账号)
 * 从 backend.ts 迁出 (管理界面插件化)。只依赖 context 原语与 PG, 可复用。
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  json, readBody, pool, hashPassword, verifyPassword, signToken, setAuthCookie,
  bearerUser, pageUserId, isAdminUser, writeAudit, emailOf, loginLimiter, loginLockKey, adminEmails,
} from "./context.js";

/** auth + /app/admin 路由处理; 返回 true = 已响应 (未命中前缀返回 false) */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!path.startsWith("/app/auth") && !path.startsWith("/app/admin/")) return false;
  const url = new URL(req.url ?? "/", "http://x");
    // 响应追踪: 块内 return json(...) 只退出 IIFE, 由"是否已 writeHead"判定 handled
    let responded = false;
    const __wh = res.writeHead.bind(res);
    (res as unknown as { writeHead: unknown }).writeHead = (...a: unknown[]) => {
      responded = true;
      return (__wh as (...a2: unknown[]) => ServerResponse)(...a);
    };
  try {
    await (async () => {
    // ── auth ──
    // 注册开关: 设 APPBASE_ALLOW_REGISTER=false 后仅已有账号可登录
    if (method === "POST" && path === "/app/auth/register") {
      if (process.env.APPBASE_ALLOW_REGISTER === "false") {
        return json(res, 403, { error: "本站已关闭注册, 请联系管理员开通账号" });
      }
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email || password.length < 6) {
        return json(res, 400, { error: "用户名或邮箱 和 password(≥6位) 必填" });
      }
      const id = randomUUID();
      const hash = await hashPassword(password);
      // 首个注册用户自动成为管理员 (兜底引导); 邮箱白名单内的也直接是管理员
      const { rows: admins } = await pool.query("SELECT 1 FROM users WHERE is_admin LIMIT 1");
      const makeAdmin = adminEmails().includes(email)
        || (admins.length === 0 && adminEmails().length === 0);
      try {
        await pool.query(
          "INSERT INTO users (id, email, password_hash, is_admin) VALUES ($1, $2, $3, $4)",
          [id, email, hash, makeAdmin],
        );
      } catch (e: any) {
        if (String(e?.code) === "23505") return json(res, 409, { error: "该用户名或邮箱已注册" });
        throw e;
      }
      const token = signToken(id);
      setAuthCookie(res, token);
      // 经应用登录门注册 (next=/apps/<appId>): 自动授予该应用成员身份, 省去管理员手工添加
      const appMatch = /^\/apps\/([^/?]+)/.exec(String(body.next ?? ""));
      if (appMatch) {
        const appId = decodeURIComponent(appMatch[1]);
        const { rows: appRow } = await pool.query("SELECT 1 FROM apps WHERE id = $1", [appId]);
        if (appRow.length > 0) {
          await pool.query(
            "INSERT INTO app_members (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [appId, id]);
          void writeAudit(email, "member.auto_add", appId, "注册于应用登录门, 自动授权");
        }
      }
      void writeAudit(email, "register", email, makeAdmin ? "(首个用户, 自动管理员)" : "");
      return json(res, 201, { token, user: { id, email, isAdmin: makeAdmin } });
    }

    if (method === "POST" && path === "/app/auth/login") {
      const body = await readBody(req);
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const ip = req.socket?.remoteAddress ?? "unknown";
      // 限流 (框架 @infrastructure/rate-limit): 同 IP+邮箱 5 次失败锁 15 分钟
      const lockKey = loginLockKey(req, email);
      const lock = loginLimiter.check(lockKey);
      if (lock.locked) {
        void writeAudit(email, "login.locked", email, `ip=${ip} 剩余约 ${lock.retryAfterMin} 分钟`);
        return json(res, 429, { error: `失败次数过多, 账号已锁定, 约 ${lock.retryAfterMin} 分钟后再试` });
      }
      const { rows } = await pool.query(
        "SELECT id, email, password_hash, is_admin FROM users WHERE email = $1",
        [email],
      );
      if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
        const after = loginLimiter.fail(lockKey);
        void writeAudit(email, "login.fail", email,
          `ip=${ip}` + (after.remaining > 0 ? ` 还可尝试 ${after.remaining} 次` : " (触发锁定)"));
        return json(res, 401, { error: after.remaining > 0 ? `用户名或密码错误 (还可尝试 ${after.remaining} 次)` : "用户名或密码错误" });
      }
      loginLimiter.reset(lockKey);
      const token = signToken(rows[0].id);
      const isAdmin = Boolean(rows[0].is_admin) || adminEmails().includes(email);
      setAuthCookie(res, token);
      void writeAudit(email, "login", email, `ip=${ip}${isAdmin ? " (管理员)" : ""}`);
      return json(res, 200, { token, user: { id: rows[0].id, email: rows[0].email, isAdmin } });
    }

    // 登出: 清除 httpOnly cookie (前端同时清 sessionStorage)
    if (method === "POST" && path === "/app/auth/logout") {
      res.setHeader("Set-Cookie", "hall_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // 当前登录者信息 (前端启动时校验 token / 拿管理员身份)
    if (method === "GET" && path === "/app/auth/me") {
      // 双轨身份: Bearer 或 httpOnly cookie (应用页裸 fetch 靠 cookie 识别)
      const userId = pageUserId(req);
      if (!userId) return json(res, 401, { error: "未登录" });
      const { rows } = await pool.query("SELECT id, email FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) return json(res, 401, { error: "用户不存在" });
      return json(res, 200, {
        user: { id: rows[0].id, email: rows[0].email, isAdmin: await isAdminUser(userId) },
      });
    }

    // ── 管理员: 用户管理 + 审计查询 (专门的用户管理应用使用) ──
    if (path.startsWith("/app/admin/")) {
      const adminId = bearerUser(req);
      if (!adminId) return json(res, 401, { error: "未授权: 请先登录" });
      if (!(await isAdminUser(adminId))) return json(res, 403, { error: "需要管理员权限" });

      if (method === "GET" && path === "/app/admin/users") {
        const { rows } = await pool.query(
          `SELECT u.id, u.email, u.is_admin, u.created_at,
                  (SELECT count(*)::int FROM app_members m WHERE m.user_id = u.id) AS member_count,
                  (SELECT count(*)::int FROM apps a WHERE a.owner_id = u.id) AS app_count
           FROM users u ORDER BY u.created_at`);
        return json(res, 200, { users: rows });
      }

      // 管理员直接创建用户（不受注册开关限制，可指定身份）
      if (method === "POST" && path === "/app/admin/users") {
        const body = await readBody(req);
        const email = String(body.email ?? "").trim().toLowerCase();
        const password = String(body.password ?? "");
        const makeAdmin = Boolean(body.is_admin);
        if (!email) {
          return json(res, 400, { error: "请输入用户名或邮箱" });
        }
        if (password.length < 6) {
          return json(res, 400, { error: "密码至少 6 位" });
        }
        const id = randomUUID();
        const hash = await hashPassword(password);
        try {
          await pool.query(
            "INSERT INTO users (id, email, password_hash, is_admin) VALUES ($1, $2, $3, $4)",
            [id, email, hash, makeAdmin]);
        } catch (e: any) {
          if (String(e?.code) === "23505") return json(res, 409, { error: "该用户名或邮箱已存在" });
          throw e;
        }
        const adminEmail = await emailOf(adminId);
        void writeAudit(adminEmail, "user.create", email, makeAdmin ? "(管理员)" : "");
        return json(res, 201, { user: { id, email, is_admin: makeAdmin } });
      }

      if (method === "GET" && path === "/app/admin/audit") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
        const { rows } = await pool.query(
          "SELECT actor, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1",
          [limit]);
        return json(res, 200, { entries: rows });
      }

      // 全部应用内账号 (跨应用统一视图, 用户管理页使用)
      if (method === "GET" && path === "/app/admin/app-accounts") {
        const { rows } = await pool.query(
          `SELECT a.id, a.app_id, a.username, a.note, a.created_at,
                  COALESCE((SELECT count(*)::int FROM app_keys k
                            WHERE k.app_id = a.app_id AND k.revoked = false), 0) AS key_count
           FROM app_accounts a ORDER BY a.app_id, a.created_at`);
        return json(res, 200, { accounts: rows });
      }

      const adminUserMatch = path.match(/^\/app\/admin\/users\/([^/]+)(?:\/([a-z]+))?$/);
      if (adminUserMatch) {
        const targetId = decodeURIComponent(adminUserMatch[1]);
        const sub = adminUserMatch[2] ?? "";
        const adminEmail = await emailOf(adminId);

        if (method === "GET" && sub === "memberships") {
          const { rows } = await pool.query(
            "SELECT app_id, added_at FROM app_members WHERE user_id = $1 ORDER BY added_at",
            [targetId]);
          return json(res, 200, { memberships: rows });
        }

        if (method === "PUT" && sub === "admin") {
          const body = await readBody(req);
          if (targetId === adminId && body.is_admin !== true) {
            return json(res, 400, { error: "不能撤销自己的管理员身份" });
          }
          // 撤销管理员时, 必须还存在其他管理员
          const { rowCount } = await pool.query(
            `UPDATE users SET is_admin = $2 WHERE id = $1
             AND ($2 = true OR (SELECT count(*) FROM users WHERE is_admin AND id <> $1) > 0)`,
            [targetId, Boolean(body.is_admin)]);
          if (rowCount === 0) {
            return json(res, body.is_admin ? 404 : 400,
              body.is_admin ? { error: "用户不存在" } : { error: "至少要保留一名管理员" });
          }
          void writeAudit(adminEmail, "user.set_admin", await emailOf(targetId),
            body.is_admin ? "设为管理员" : "取消管理员");
          return json(res, 200, { ok: true });
        }

        if (method === "PUT" && sub === "password") {
          const body = await readBody(req);
          const newPassword = String(body.newPassword ?? "");
          if (newPassword.length < 6) return json(res, 400, { error: "新密码至少 6 位" });
          const hash = await hashPassword(newPassword);
          const { rowCount } = await pool.query(
            "UPDATE users SET password_hash = $2 WHERE id = $1", [targetId, hash]);
          if (rowCount === 0) return json(res, 404, { error: "用户不存在" });
          void writeAudit(adminEmail, "user.reset_password", await emailOf(targetId));
          return json(res, 200, { ok: true });
        }

        if (method === "DELETE" && sub === "member") {
          const appId = String(new URL(req.url ?? "/", "http://x").searchParams.get("app") ?? "");
          if (!appId) return json(res, 400, { error: "缺少 app 参数" });
          await pool.query("DELETE FROM app_members WHERE user_id = $1 AND app_id = $2",
            [targetId, appId]);
          void writeAudit(adminEmail, "app.member_remove", appId, `移出 ${await emailOf(targetId)}`);
          return json(res, 200, { ok: true });
        }

        if (method === "DELETE" && sub === "") {
          if (targetId === adminId) return json(res, 400, { error: "不能删除自己的账号" });
          const { rows: owned } = await pool.query(
            "SELECT count(*)::int AS n FROM apps WHERE owner_id = $1", [targetId]);
          if (owned[0].n > 0) {
            return json(res, 409, { error: `该用户名下还有 ${owned[0].n} 个应用, 请先处理应用归属再删除` });
          }
          await pool.query("DELETE FROM app_members WHERE user_id = $1", [targetId]);
          const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [targetId]);
          if (rowCount === 0) return json(res, 404, { error: "用户不存在" });
          void writeAudit(adminEmail, "user.delete", await emailOf(targetId));
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "admin: not found" });
    }
    })();

  } catch (e) {
    json(res, 500, { error: String((e as Error)?.message ?? e) });
  }
      if (responded) return true;
    json(res, 404, { error: "users: not found" });
  return true;
}
