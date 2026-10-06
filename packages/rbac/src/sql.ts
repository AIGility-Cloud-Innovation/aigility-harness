/** RBAC 表结构（PostgreSQL）。站点库执行一次（CREATE TABLE IF NOT EXISTS 幂等）。
 *  字段对齐 hire_web_backend 自研 RBAC（re_* 系列），改名 rbac_* 前缀；
 *  剥离：re_user_rbac（站点自有用户表）、tenant 配额字段（租户隔离不参与权限判定）。 */
export const RBAC_DDL = `
CREATE TABLE IF NOT EXISTS rbac_role (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rbac_user_role (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_id BIGINT NOT NULL REFERENCES rbac_role(id) ON DELETE CASCADE,
  expire_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS rbac_permission (
  id BIGSERIAL PRIMARY KEY,
  code INTEGER NOT NULL UNIQUE,
  key VARCHAR(128) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50),
  action VARCHAR(50),
  is_enabled BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS rbac_permission_group (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_enabled BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS rbac_permission_group_permission (
  id BIGSERIAL PRIMARY KEY,
  group_id BIGINT NOT NULL REFERENCES rbac_permission_group(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES rbac_permission(id) ON DELETE CASCADE,
  UNIQUE (group_id, permission_id)
);
CREATE TABLE IF NOT EXISTS rbac_role_permission_group (
  id BIGSERIAL PRIMARY KEY,
  role_id BIGINT NOT NULL REFERENCES rbac_role(id) ON DELETE CASCADE,
  group_id BIGINT NOT NULL REFERENCES rbac_permission_group(id) ON DELETE CASCADE,
  UNIQUE (role_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_rbac_user_role_user ON rbac_user_role(user_id);
CREATE INDEX IF NOT EXISTS idx_rbac_rpg_role ON rbac_role_permission_group(role_id);
`;
