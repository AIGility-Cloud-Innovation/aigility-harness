/**
 * Admin module: harness-plugins — 框架层(LayerPlugin)插件只读管理
 * 经 kernel.registry.listAllServices() 枚举全部 Seam 服务。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, bearerUser, isAdminUser } from "./context.js";
import { getAdminKernel, getAdminManifests } from "./kernel-ref.js";

/** 框架层插件枚举 (管理员); 返回 true = 已响应 */
export async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== "/app/admin/harness-plugins") return false;
  if (method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const adminId = bearerUser(req);
  if (!adminId) {
    json(res, 401, { error: "未授权: 请先登录" });
    return true;
  }
  if (!(await isAdminUser(adminId))) {
    json(res, 403, { error: "需要管理员权限" });
    return true;
  }
  const kernel = getAdminKernel();
  if (!kernel) {
    json(res, 503, { error: "内核未注入" });
    return true;
  }
  const all = kernel.registry.listAllServices();
  // provides/consumes 数据源是 LayerPlugin.manifest (ServiceDefinition 上没有这两个字段):
  // 按服务 id 反查所属 manifest, 提供该 manifest 的 provides/consumes 数量
  const manifestByService = new Map<string, { provides: number; consumes: number; plugin: string }>();
  for (const m of getAdminManifests()) {
    const providesArr = Array.isArray(m.provides) ? m.provides : [];
    const consumesArr = Array.isArray(m.consumes) ? m.consumes : [];
    for (const svc of providesArr) {
      const id = (svc as { id?: string })?.id;
      if (typeof id === "string") {
        manifestByService.set(id, { provides: providesArr.length, consumes: consumesArr.length, plugin: m.name });
      }
    }
  }
  const items = [];
  for (const entry of all) {
    const svc = entry.service as {
      id: string; version: string; layer: string; description: string;
    };
    const counts = manifestByService.get(svc.id);
    items.push({
      id: svc.id,
      version: svc.version,
      layer: svc.layer,
      description: svc.description,
      provides: counts?.provides ?? 0,
      consumes: counts?.consumes ?? 0,
      plugin: counts?.plugin,
      providerName: entry.providerName,
      state: entry.state,
    });
  }
  json(res, 200, { plugins: items });
  return true;
}
