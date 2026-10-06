/**
 * RbacStore 的 AppBase PG 实现 + 建表 + 种子（智悦站点适配）。
 *
 * 分离纪律：机制在 @aigility-harness/rbac（模型/解析/判定），数据在站点——
 * 权限码目录是智悦业务语义（模块号段对齐 hire 惯例：100s 工厂 / 200s 市场 / 300s 编排 /
 * 400s 项目小助理 / 600s 系统），由本文件播种；认证归 AppBase 登录，本文件只管授权。
 *
 * 与 is_admin 过渡实现共存：RBAC 管理端点双门放行（isUserAdmin 或 rbac system:rbac:manage），
 * isUserAdmin 在 RBAC 全面接管后退役。
 */
import { RBAC_DDL } from "@aigility-harness/rbac/sql";
import type { RbacPermission, RbacPermissionGroup, RbacRole, RbacStore, RbacUserRole } from "@aigility-harness/rbac";
import { pool } from "@aigility-harness/appbase/backend";

const rowToRole = (r: Record<string, unknown>): RbacRole => ({
  id: Number(r.id),
  code: String(r.code),
  name: String(r.name),
  level: Number(r.level ?? 0),
  isSystem: Boolean(r.is_system),
  enabled: Boolean(r.is_enabled),
});

export class PgRbacStore implements RbacStore {
  async listUserRoles(userId: string): Promise<RbacUserRole[]> {
    const { rows } = await pool.query(
      "SELECT role_id, expire_time FROM rbac_user_role WHERE user_id = $1",
      [userId],
    );
    return rows.map((r) => ({
      userId,
      roleId: Number(r.role_id),
      expireTime: r.expire_time ? new Date(r.expire_time).toISOString() : null,
    }));
  }
  async listRolesByIds(ids: number[]): Promise<RbacRole[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query("SELECT * FROM rbac_role WHERE id = ANY($1) AND is_enabled", [ids]);
    return rows.map(rowToRole);
  }
  async listGroupIdsByRoleIds(roleIds: number[]): Promise<number[]> {
    if (!roleIds.length) return [];
    const { rows } = await pool.query(
      "SELECT DISTINCT group_id FROM rbac_role_permission_group WHERE role_id = ANY($1)",
      [roleIds],
    );
    return rows.map((r) => Number(r.group_id));
  }
  async listPermissionIdsByGroupIds(groupIds: number[]): Promise<number[]> {
    if (!groupIds.length) return [];
    const { rows } = await pool.query(
      "SELECT DISTINCT permission_id FROM rbac_permission_group_permission WHERE group_id = ANY($1)",
      [groupIds],
    );
    return rows.map((r) => Number(r.permission_id));
  }
  async listPermissionsByIds(ids: number[]): Promise<RbacPermission[]> {
    if (!ids.length) return [];
    const { rows } = await pool.query("SELECT * FROM rbac_permission WHERE id = ANY($1) AND is_enabled", [ids]);
    return rows.map((r) => ({
      id: Number(r.id), code: Number(r.code), key: String(r.key), name: String(r.name),
      resourceType: r.resource_type ?? undefined, action: r.action ?? undefined, enabled: Boolean(r.is_enabled),
    }));
  }
  async createRole(role: { code: string; name: string; level?: number; isSystem?: boolean }): Promise<RbacRole> {
    const { rows } = await pool.query(
      "INSERT INTO rbac_role (code, name, level, is_system) VALUES ($1,$2,$3,$4) RETURNING *",
      [role.code, role.name, role.level ?? 0, role.isSystem ?? false],
    );
    return rowToRole(rows[0]);
  }
  async createUserRole(userId: string, roleId: number, expireTime?: string | null): Promise<void> {
    await pool.query(
      "INSERT INTO rbac_user_role (user_id, role_id, expire_time) VALUES ($1,$2,$3) ON CONFLICT (user_id, role_id) DO UPDATE SET expire_time = EXCLUDED.expire_time",
      [userId, roleId, expireTime ?? null],
    );
  }
  async deleteUserRole(userId: string, roleId: number): Promise<void> {
    await pool.query("DELETE FROM rbac_user_role WHERE user_id = $1 AND role_id = $2", [userId, roleId]);
  }
  async listGroups(): Promise<RbacPermissionGroup[]> {
    const { rows } = await pool.query("SELECT * FROM rbac_permission_group WHERE is_enabled ORDER BY sort_order");
    return rows.map((r) => ({
      id: Number(r.id), code: String(r.code), name: String(r.name),
      sortOrder: Number(r.sort_order), isSystem: Boolean(r.is_system), enabled: Boolean(r.is_enabled),
    }));
  }
  async listRoles(): Promise<RbacRole[]> {
    const { rows } = await pool.query("SELECT * FROM rbac_role WHERE is_enabled ORDER BY level DESC");
    return rows.map(rowToRole);
  }
  async listPermissions(): Promise<RbacPermission[]> {
    const { rows } = await pool.query("SELECT * FROM rbac_permission WHERE is_enabled ORDER BY code");
    return rows.map((r) => ({
      id: Number(r.id), code: Number(r.code), key: String(r.key), name: String(r.name),
      resourceType: r.resource_type ?? undefined, action: r.action ?? undefined, enabled: Boolean(r.is_enabled),
    }));
  }
  async setRoleGroups(roleId: number, groupIds: number[]): Promise<void> {
    await pool.query("DELETE FROM rbac_role_permission_group WHERE role_id = $1", [roleId]);
    for (const g of groupIds) {
      await pool.query("INSERT INTO rbac_role_permission_group (role_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [roleId, g]);
    }
  }
  async createGroup(g: { code: string; name: string; sortOrder?: number; isSystem?: boolean }): Promise<RbacPermissionGroup> {
    const { rows } = await pool.query(
      "INSERT INTO rbac_permission_group (code, name, sort_order, is_system) VALUES ($1,$2,$3,$4) RETURNING *",
      [g.code, g.name, g.sortOrder ?? 0, g.isSystem ?? false],
    );
    return { id: Number(rows[0].id), code: String(rows[0].code), name: String(rows[0].name), sortOrder: Number(rows[0].sort_order), isSystem: Boolean(rows[0].is_system), enabled: true };
  }
  async createPermission(p: { code: number; key: string; name: string; resourceType?: string; action?: string }): Promise<RbacPermission> {
    const { rows } = await pool.query(
      "INSERT INTO rbac_permission (code, key, name, resource_type, action) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [p.code, p.key, p.name, p.resourceType ?? null, p.action ?? null],
    );
    return { id: Number(rows[0].id), code: Number(rows[0].code), key: String(rows[0].key), name: String(rows[0].name), resourceType: rows[0].resource_type ?? undefined, action: rows[0].action ?? undefined, enabled: true };
  }
  async setGroupPermissions(groupId: number, permissionIds: number[]): Promise<void> {
    await pool.query("DELETE FROM rbac_permission_group_permission WHERE group_id = $1", [groupId]);
    for (const p of permissionIds) {
      await pool.query("INSERT INTO rbac_permission_group_permission (group_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [groupId, p]);
    }
  }
  async listRoleGroupIds(roleId: number): Promise<number[]> {
    const { rows } = await pool.query("SELECT group_id FROM rbac_role_permission_group WHERE role_id = $1", [roleId]);
    return rows.map((r) => Number(r.group_id));
  }
  async roleByCode(code: string): Promise<RbacRole | null> {
    const { rows } = await pool.query("SELECT * FROM rbac_role WHERE code = $1", [code]);
    return rows[0] ? rowToRole(rows[0]) : null;
  }
  async groupByCode(code: string): Promise<RbacPermissionGroup | null> {
    const { rows } = await pool.query("SELECT * FROM rbac_permission_group WHERE code = $1", [code]);
    return rows[0] ? { id: Number(rows[0].id), code: String(rows[0].code), name: String(rows[0].name), sortOrder: Number(rows[0].sort_order), isSystem: Boolean(rows[0].is_system), enabled: true } : null;
  }
  async permissionByKey(key: string): Promise<RbacPermission | null> {
    const { rows } = await pool.query("SELECT * FROM rbac_permission WHERE key = $1", [key]);
    return rows[0] ? { id: Number(rows[0].id), code: Number(rows[0].code), key: String(rows[0].key), name: String(rows[0].name), enabled: true } : null;
  }
}

// ── 建表 + 种子（幂等）─────────────────────────────────────────

/** 智悦权限码目录（号段对齐 hire 惯例：模块号段 + `模块:资源:操作` 键） */
const CATALOG: Array<{ group: { code: string; name: string }; perms: Array<{ code: number; key: string; name: string }> }> = [
  { group: { code: "factory_module", name: "智能体工厂" }, perms: [
    { code: 101, key: "factory:read", name: "查看工厂" },
    { code: 102, key: "factory:publish", name: "发布数字员工" },
    { code: 103, key: "factory:role-package:write", name: "编辑角色包" },
  ] },
  { group: { code: "market_module", name: "智能体市场" }, perms: [
    { code: 201, key: "market:read", name: "浏览市场" },
    { code: 202, key: "market:install", name: "安装到工厂" },
  ] },
  { group: { code: "orchestration_module", name: "编排管理" }, perms: [
    { code: 301, key: "orchestration:read", name: "查看编排" },
    { code: 302, key: "orchestration:write", name: "编辑工作流" },
  ] },
  { group: { code: "taskloop_module", name: "项目小助理" }, perms: [
    { code: 401, key: "taskloop:manage", name: "管理与配置" },
    { code: 402, key: "taskloop:board:read", name: "查看任务板" },
  ] },
  { group: { code: "model_module", name: "模型算力" }, perms: [
    { code: 501, key: "model:read", name: "查看模型配置" },
    { code: 502, key: "model:manage", name: "管理模型节点" },
  ] },
  { group: { code: "system_module", name: "系统管理" }, perms: [
    { code: 601, key: "system:audit:read", name: "查看审计" },
    { code: 602, key: "system:rbac:manage", name: "管理角色与权限" },
    { code: 603, key: "system:nav:manage", name: "管理导航布局" },
  ] },
];

let readyPromise: Promise<void> | null = null;

/** 建表 + 播种目录 + admin 角色全量绑定 + admin 账号授权（幂等，进程内单次） */
export function ensureRbacReady(): Promise<void> {
  readyPromise ??= (async () => {
    await pool.query(RBAC_DDL);
    const store = new PgRbacStore();
    let adminRole = await store.roleByCode("admin");
    let memberRole = await store.roleByCode("member");
    const groupIds: number[] = [];
    for (const [i, entry] of CATALOG.entries()) {
      let group = await store.groupByCode(entry.group.code);
      if (!group) group = await store.createGroup({ ...entry.group, sortOrder: i, isSystem: true });
      groupIds.push(group.id);
      const permIds: number[] = [];
      for (const p of entry.perms) {
        let perm = await store.permissionByKey(p.key);
        if (!perm) perm = await store.createPermission({ ...p, resourceType: entry.group.code.replace("_module", ""), action: p.key.split(":").pop() });
        permIds.push(perm.id);
      }
      await store.setGroupPermissions(group.id, permIds);
    }
    if (!adminRole) adminRole = await store.createRole({ code: "admin", name: "管理员", level: 100, isSystem: true });
    if (!memberRole) memberRole = await store.createRole({ code: "member", name: "成员", level: 10 });
    await store.setRoleGroups(adminRole.id, groupIds);
    // member 只读集独立成组（不污染 factory_module 的业务语义）
    const readKeys = ["factory:read", "market:read", "orchestration:read", "taskloop:board:read", "model:read"];
    const readIds: number[] = [];
    for (const k of readKeys) {
      const perm = await store.permissionByKey(k);
      if (perm) readIds.push(perm.id);
    }
    let memberRead = await store.groupByCode("member_read_module");
    if (!memberRead) memberRead = await store.createGroup({ code: "member_read_module", name: "基础只读", sortOrder: 90, isSystem: true });
    await store.setGroupPermissions(memberRead.id, readIds);
    await store.setRoleGroups(memberRole.id, [memberRead.id]);
    // admin 账号 → admin 角色（幂等）
    const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", ["admin@aigility.local"]);
    if (rows[0]) await store.createUserRole(String(rows[0].id), adminRole.id);
  })();
  return readyPromise;
}

export const rbacStore = new PgRbacStore();
