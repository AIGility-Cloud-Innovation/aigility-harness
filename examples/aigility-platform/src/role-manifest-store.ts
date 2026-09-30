/**
 * 角色 manifest v2 原子写回 —— 平台「通道与角色」页的持久化层
 *
 * 职责：loadRoleManifestFile 的写侧对称（tmp+rename 原子替换，对齐 identity-registry
 * persistIdentityRegistry 惯例）；upsert/remove 纯函数 + 校验前置（不合格声明拒写）。
 * 写入即审计（审计由 API 层做）。
 */
import { renameSync, writeFileSync } from "node:fs";
import { loadRoleManifestFile, roleManifestPath, validateManifest, type RoleManifestV2 } from "./role-manifest.js";

/** 返回 null = 成功；字符串 = 拒绝原因（校验失败） */
export function upsertRoleManifest(input: Partial<RoleManifestV2>): { ok: true; manifest: RoleManifestV2 } | { ok: false; error: string } {
  const normalized: RoleManifestV2 = {
    role_id: String(input.role_id ?? "").trim(),
    identity: {
      name: String(input.identity?.name ?? "").trim(),
      signature: input.identity?.signature?.trim() || undefined,
      capability_ref: input.identity?.capability_ref?.trim() || undefined,
    },
    sources: {
      channels: input.sources?.channels,
      data: input.sources?.data ?? [],
    },
    actions: {
      tools: input.actions?.tools ?? [],
      workflows: input.actions?.workflows ?? [],
      engine: input.actions?.engine?.trim() || undefined,
    },
    outbound: {
      reply: input.outbound?.reply,
      push: input.outbound?.push ?? [],
    },
    memory: { agent_id: String(input.memory?.agent_id ?? input.role_id ?? "").trim() },
  };
  if (!normalized.memory.agent_id) normalized.memory.agent_id = normalized.role_id;
  const issues = validateManifest(normalized);
  if (issues.length) return { ok: false, error: `声明校验失败: ${issues.join("; ")}` };

  const path = roleManifestPath();
  if (!path) return { ok: false, error: "找不到 config/role-manifests.json（ROLE_MANIFEST_PATH 可指定）" };
  const file = loadRoleManifestFile(path);
  const idx = file.roles.findIndex((r) => r.role_id === normalized.role_id);
  if (idx >= 0) file.roles[idx] = normalized;
  else file.roles.push(normalized);
  writeManifestFile(path, file);
  return { ok: true, manifest: normalized };
}

export function removeRoleManifest(roleId: string): { ok: boolean; error?: string } {
  const path = roleManifestPath();
  if (!path) return { ok: false, error: "找不到 config/role-manifests.json" };
  const file = loadRoleManifestFile(path);
  const before = file.roles.length;
  file.roles = file.roles.filter((r) => r.role_id !== roleId);
  if (file.roles.length === before) return { ok: false, error: `角色 ${roleId} 不在声明清单中` };
  writeManifestFile(path, file);
  return { ok: true };
}

/** 原子写回（tmp+rename）：$schema 文档键与 notes 原样保留，刷新 updated_at */
function writeManifestFile(path: string, file: ReturnType<typeof loadRoleManifestFile>): void {
  file.updated_at = new Date().toISOString();
  const payload: Record<string, unknown> = { ...file };
  if (file.doc_note) {
    payload.$schema = file.doc_note;
    delete payload.doc_note;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
