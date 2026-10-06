/**
 * RBAC 鉴权机制包（底座能力）—— 移植自 hire_web_backend 自研 RBAC
 * （User → Role → PermissionGroup → Permission 四层，权限键 `模块:资源:操作` 精确匹配）。
 *
 * 保留的语义（对齐源实现）：
 *   · 三步解析：user → 有效角色（过滤禁用/临时授权过期）→ 权限组 → 权限键集合；
 *   · 纯精确匹配，any（OR）/ all（AND）两种模式；无超管旁路——admin 的全权来自种子数据；
 *   · rbac_user_role.expire_time 支持临时授权。
 * 剥离（站点职责）：认证登录（AppBase 已有）、SHA256/JWT、租户配额、业务权限码目录（站点播种）。
 * 机制在包、数据在站点：存储经 RbacStore 接口适配（内存实现供测试；站点实现如 AppBase PG）。
 */

// ── 模型 ────────────────────────────────────────────────────────

export interface RbacRole {
  id: number;
  code: string;
  name: string;
  level: number;
  isSystem: boolean;
  enabled: boolean;
}

export interface RbacUserRole {
  userId: string;
  roleId: number;
  /** 临时授权截止时刻；null = 永久 */
  expireTime: string | null;
}

export interface RbacPermission {
  id: number;
  code: number;
  key: string;
  name: string;
  resourceType?: string;
  action?: string;
  enabled: boolean;
}

export interface RbacPermissionGroup {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  enabled: boolean;
}

/** 存储接口（站点适配：PG / 内存 / 远程服务均可） */
export interface RbacStore {
  listUserRoles(userId: string): Promise<RbacUserRole[]>;
  listRolesByIds(ids: number[]): Promise<RbacRole[]>;
  listGroupIdsByRoleIds(roleIds: number[]): Promise<number[]>;
  listPermissionIdsByGroupIds(groupIds: number[]): Promise<number[]>;
  listPermissionsByIds(ids: number[]): Promise<RbacPermission[]>;
  // 写侧（管理服务用）
  createRole(role: { code: string; name: string; level?: number; isSystem?: boolean }): Promise<RbacRole>;
  createUserRole(userId: string, roleId: number, expireTime?: string | null): Promise<void>;
  deleteUserRole(userId: string, roleId: number): Promise<void>;
  listGroups(): Promise<RbacPermissionGroup[]>;
  listRoles(): Promise<RbacRole[]>;
  listPermissions(): Promise<RbacPermission[]>;
  setRoleGroups(roleId: number, groupIds: number[]): Promise<void>;
  createGroup(group: { code: string; name: string; sortOrder?: number; isSystem?: boolean }): Promise<RbacPermissionGroup>;
  createPermission(p: { code: number; key: string; name: string; resourceType?: string; action?: string }): Promise<RbacPermission>;
  setGroupPermissions(groupId: number, permissionIds: number[]): Promise<void>;
  listRoleGroupIds(roleId: number): Promise<number[]>;
}

// ── 三步解析（对齐 RBACDAO._resolve_user_permission_ids）─────────

/** user → 有效角色 → 权限组 → 权限键集合（精确匹配语义的基础） */
export async function resolveUserPermissionKeys(
  store: RbacStore,
  userId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const userRoles = (await store.listUserRoles(userId)).filter(
    (ur) => !ur.expireTime || new Date(ur.expireTime) > now,
  );
  if (!userRoles.length) return new Set();
  const roles = (await store.listRolesByIds(userRoles.map((ur) => ur.roleId))).filter((r) => r.enabled);
  if (!roles.length) return new Set();
  const groupIds = await store.listGroupIdsByRoleIds(roles.map((r) => r.id));
  if (!groupIds.length) return new Set();
  const permissionIds = await store.listPermissionIdsByGroupIds(groupIds);
  if (!permissionIds.length) return new Set();
  const permissions = await store.listPermissionsByIds(permissionIds);
  return new Set(permissions.filter((p) => p.enabled).map((p) => p.key));
}

export type PermissionCheckMode = "any" | "all";

export interface PermissionCheckResult {
  ok: boolean;
  /** 未持有的键（deny 时回显用） */
  missing: string[];
}

/** 判定：keys 任一（any）或全部（all）在用户权限集合内 */
export async function checkPermissions(
  store: RbacStore,
  userId: string,
  keys: string | string[],
  mode: PermissionCheckMode = "any",
  now: Date = new Date(),
): Promise<PermissionCheckResult> {
  const required = Array.isArray(keys) ? keys : [keys];
  const owned = await resolveUserPermissionKeys(store, userId, now);
  const missing = required.filter((k) => !owned.has(k));
  const ok = mode === "all" ? missing.length === 0 : missing.length < required.length;
  return { ok, missing };
}

/** 判定工厂（站点路由守卫适配）：bind store + 用户解析后返回 check 函数 */
export function createPermissionGuard(store: RbacStore, getUserId: () => string | null | Promise<string | null>) {
  return (keys: string | string[], mode: PermissionCheckMode = "any") =>
    async (): Promise<PermissionCheckResult & { userId: string | null }> => {
      const userId = await getUserId();
      if (!userId) return { ok: false, missing: requiredOf(keys), userId };
      const r = await checkPermissions(store, userId, keys, mode);
      return { ...r, userId };
    };
}

function requiredOf(keys: string | string[]): string[] {
  return Array.isArray(keys) ? keys : [keys];
}

// ── 管理服务（站点管理端点调用）────────────────────────────────

export async function assignRoleToUser(store: RbacStore, userId: string, roleId: number, expireTime?: string | null): Promise<void> {
  await store.createUserRole(userId, roleId, expireTime ?? null);
}

export async function revokeRoleFromUser(store: RbacStore, userId: string, roleId: number): Promise<void> {
  await store.deleteUserRole(userId, roleId);
}

/** 整体设置角色的权限组集合（对齐 hire 的批量配组端点语义） */
export async function setRolePermissionGroups(store: RbacStore, roleId: number, groupIds: number[]): Promise<void> {
  await store.setRoleGroups(roleId, groupIds);
}
