/**
 * Admin modules 注册表: 管理模块统一挂载 + 面板清单 + 分发入口。
 *
 * 模块契约: 每个模块自带 prefix 判定与 handle, 未命中返回 false;
 * adminPanelList 供管理壳页渲染标签 —— 未来插件经 manifest.adminPanels
 * 声明的面板可追加进清单 (壳自动出现新标签)。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as usersMod from "./users.js";
import * as llmConfigMod from "./llm-config.js";
import * as dshPluginsMod from "./dsh-plugins.js";
import * as harnessPluginsMod from "./harness-plugins.js";
import * as tokenUsageMod from "./token-usage.js";
import * as creditsMod from "./credits.js";
import * as meMod from "./me.js";
export { setAdminKernel, setAdminManifests } from "./kernel-ref.js";

export interface AdminModuleDef {
  id: string;
  title: string;
  icon: string;
  /** 标签顺序 (小在前) */
  order: number;
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string) => Promise<boolean>;
  /** true = 只参与分发, 不在 /admin 壳页出标签 (如用户自读的 /app/me/*) */
  hidden?: boolean;
}

// 数组顺序 = 分发顺序 (精确路径的模块在前, 防止宽前缀拦截);
// 标签展示顺序由 order 字段决定, 与分发顺序无关
// 数组顺序 = 分发顺序 (精确路径的模块在前, 防止宽前缀拦截);
// 标签展示顺序由 order 字段决定, 与分发顺序无关
const MODULES: AdminModuleDef[] = [
  { id: "harness-plugins", title: "框架层插件", icon: "⚙", order: 40, handle: harnessPluginsMod.handle },
  { id: "token-usage", title: "Token 用量", icon: "📊", order: 50, handle: tokenUsageMod.handle },
  { id: "credits", title: "积分账务", icon: "💰", order: 60, handle: creditsMod.handle },
  { id: "me", title: "个人中心", icon: "👤", order: 90, hidden: true, handle: meMod.handle }, // /app/me/* 用户自读接口, 无壳页标签
  { id: "users", title: "账号与用户", icon: "👥", order: 10, handle: usersMod.handle },
  { id: "llm-config", title: "LLM 配置", icon: "🌐", order: 20, handle: llmConfigMod.handle },
  { id: "dsh-plugins", title: "DSH 插件", icon: "🧩", order: 30, handle: dshPluginsMod.handle },
];

/** 面板清单 (供壳页渲染标签) */
export function adminPanelList(): Array<{ id: string; title: string; icon: string; order: number }> {
  return MODULES.filter((m) => !m.hidden)
    .map((m) => ({ id: m.id, title: m.title, icon: m.icon, order: m.order }))
    .sort((a, b) => a.order - b.order);
}

/** 分发入口: 命中任一模块即响应并返回 true; backend.ts 主路由最先调用 */
export async function adminDispatch(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  // 管理壳页面板清单 (管理员)
  if (path === "/app/hall/admin-panels") {
    const { json, pageUserId, isAdminUser } = await import("./context.js");
    const uid = pageUserId(req);
    if (!uid || !(await isAdminUser(uid))) {
      json(res, 403, { error: "需要管理员权限" });
      return true;
    }
    json(res, 200, { panels: adminPanelList() });
    return true;
  }
  for (const m of MODULES) {
    if (await m.handle(req, res, path, method)) return true;
  }
  return false;
}
