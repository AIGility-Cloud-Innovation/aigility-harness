import { describe, expect, it } from "vitest";
import {
  assignRoleToUser,
  checkPermissions,
  createPermissionGuard,
  resolveUserPermissionKeys,
  revokeRoleFromUser,
  setRolePermissionGroups,
  type RbacPermission,
  type RbacRole,
  type RbacStore,
  type RbacUserRole,
} from "./index.js";

/** 内存实现（测试与本地原型用；站点实现如 AppBase PG） */
class MemoryRbacStore implements RbacStore {
  roles: RbacRole[] = [];
  userRoles: RbacUserRole[] = [];
  groups: { id: number; code: string; name: string; sortOrder: number; isSystem: boolean; enabled: boolean }[] = [];
  permissions: RbacPermission[] = [];
  roleGroups: [number, number][] = [];
  groupPermissions: [number, number][] = [];
  private seq = 1000;

  async listUserRoles(userId: string) { return this.userRoles.filter((u) => u.userId === userId); }
  async listRolesByIds(ids: number[]) { return this.roles.filter((r) => ids.includes(r.id)); }
  async listGroupIdsByRoleIds(roleIds: number[]) { return this.roleGroups.filter(([r]) => roleIds.includes(r)).map(([, g]) => g); }
  async listPermissionIdsByGroupIds(groupIds: number[]) { return this.groupPermissions.filter(([g]) => groupIds.includes(g)).map(([, p]) => p); }
  async listPermissionsByIds(ids: number[]) { return this.permissions.filter((p) => ids.includes(p.id)); }
  async createRole(role: { code: string; name: string; level?: number; isSystem?: boolean }) {
    const r: RbacRole = { id: ++this.seq, code: role.code, name: role.name, level: role.level ?? 0, isSystem: role.isSystem ?? false, enabled: true };
    this.roles.push(r);
    return r;
  }
  async createUserRole(userId: string, roleId: number, expireTime?: string | null) {
    this.userRoles.push({ userId, roleId, expireTime: expireTime ?? null });
  }
  async deleteUserRole(userId: string, roleId: number) {
    this.userRoles = this.userRoles.filter((u) => !(u.userId === userId && u.roleId === roleId));
  }
  async listGroups() { return this.groups; }
  async listRoles() { return this.roles; }
  async listPermissions() { return this.permissions; }
  async setRoleGroups(roleId: number, groupIds: number[]) {
    this.roleGroups = this.roleGroups.filter(([r]) => r !== roleId).concat(groupIds.map((g) => [roleId, g] as [number, number]));
  }
  async createGroup(g: { code: string; name: string; sortOrder?: number; isSystem?: boolean }) {
    const grp = { id: ++this.seq, code: g.code, name: g.name, sortOrder: g.sortOrder ?? 0, isSystem: g.isSystem ?? false, enabled: true };
    this.groups.push(grp);
    return grp;
  }
  async createPermission(p: { code: number; key: string; name: string; resourceType?: string; action?: string }) {
    const perm: RbacPermission = { id: ++this.seq, code: p.code, key: p.key, name: p.name, resourceType: p.resourceType, action: p.action, enabled: true };
    this.permissions.push(perm);
    return perm;
  }
  async setGroupPermissions(groupId: number, permissionIds: number[]) {
    this.groupPermissions = this.groupPermissions.filter(([g]) => g !== groupId).concat(permissionIds.map((p) => [groupId, p] as [number, number]));
  }
  async listRoleGroupIds(roleId: number) { return this.roleGroups.filter(([r]) => r === roleId).map(([, g]) => g); }
}

async function seeded() {
  const store = new MemoryRbacStore();
  const admin = await store.createRole({ code: "admin", name: "管理员", level: 100, isSystem: true });
  const viewer = await store.createRole({ code: "viewer", name: "只读", level: 10 });
  const gAll = await store.createGroup({ code: "system_module", name: "系统管理", isSystem: true });
  const gFactory = await store.createGroup({ code: "factory_module", name: "智能体工厂" });
  const pAudit = await store.createPermission({ code: 601, key: "system:audit:read", name: "查看审计", resourceType: "system", action: "read" });
  const pRbac = await store.createPermission({ code: 602, key: "system:rbac:manage", name: "管理角色权限", resourceType: "system", action: "manage" });
  const pFactory = await store.createPermission({ code: 101, key: "factory:read", name: "查看工厂", resourceType: "factory", action: "read" });
  await store.setGroupPermissions(gAll.id, [pAudit.id, pRbac.id]);
  await store.setGroupPermissions(gFactory.id, [pFactory.id]);
  await setRolePermissionGroups(store, admin.id, [gAll.id, gFactory.id]);
  await setRolePermissionGroups(store, viewer.id, [gFactory.id]);
  return { store, admin, viewer, keys: { pAudit, pRbac, pFactory } };
}

describe("RBAC 机制包（移植自 hire_web_backend）", () => {
  it("三步解析：user → 有效角色 → 组 → 权限键集合", async () => {
    const { store, admin } = await seeded();
    await assignRoleToUser(store, "u-admin", admin.id);
    const keys = await resolveUserPermissionKeys(store, "u-admin");
    expect(keys.has("system:audit:read")).toBe(true);
    expect(keys.has("system:rbac:manage")).toBe(true);
    expect(keys.has("factory:read")).toBe(true);
  });

  it("临时授权过期后权限消失（expire_time 语义）", async () => {
    const { store, viewer } = await seeded();
    const past = new Date(Date.now() - 1000).toISOString();
    await assignRoleToUser(store, "u-temp", viewer.id, past);
    const keys = await resolveUserPermissionKeys(store, "u-temp");
    expect(keys.size).toBe(0);
    const future = new Date(Date.now() + 86400_000).toISOString();
    await assignRoleToUser(store, "u-temp2", viewer.id, future);
    expect((await resolveUserPermissionKeys(store, "u-temp2")).has("factory:read")).toBe(true);
  });

  it("禁用角色/权限不参与解析；撤角色即时生效", async () => {
    const { store, viewer } = await seeded();
    await assignRoleToUser(store, "u1", viewer.id);
    expect((await checkPermissions(store, "u1", "factory:read")).ok).toBe(true);
    viewer.enabled = false;
    expect((await resolveUserPermissionKeys(store, "u1")).size).toBe(0);
    viewer.enabled = true;
    await revokeRoleFromUser(store, "u1", viewer.id);
    expect((await checkPermissions(store, "u1", "factory:read")).ok).toBe(false);
  });

  it("any / all 两种模式", async () => {
    const { store, admin } = await seeded();
    await assignRoleToUser(store, "u2", admin.id);
    expect((await checkPermissions(store, "u2", ["system:audit:read", "factory:read"], "any")).ok).toBe(true);
    expect((await checkPermissions(store, "u2", ["system:audit:read", "factory:read"], "all")).ok).toBe(true);
    expect((await checkPermissions(store, "u2", ["system:audit:read", "nope:thing"], "all")).ok).toBe(false);
    const r = await checkPermissions(store, "u2", ["nope:thing"], "any");
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["nope:thing"]);
  });

  it("无超管旁路：admin 全权来自种子绑定，未绑定的 admin 无权", async () => {
    const { store, admin } = await seeded();
    // 新建一个 admin-code 角色但不挂任何组
    const naked = await store.createRole({ code: "admin2", name: "无权管理员", level: 100 });
    await assignRoleToUser(store, "u-naked", naked.id);
    expect((await checkPermissions(store, "u-naked", "system:rbac:manage")).ok).toBe(false);
    // 真 admin 有权
    await assignRoleToUser(store, "u3", admin.id);
    expect((await checkPermissions(store, "u3", "system:rbac:manage")).ok).toBe(true);
  });

  it("判定工厂：用户解析失败 = 拒绝并回显 missing", async () => {
    const { store } = await seeded();
    const guard = createPermissionGuard(store, () => null);
    const r = await guard("system:audit:read")();
    expect(r.ok).toBe(false);
    expect(r.userId).toBeNull();
    expect(r.missing).toEqual(["system:audit:read"]);
  });
});
