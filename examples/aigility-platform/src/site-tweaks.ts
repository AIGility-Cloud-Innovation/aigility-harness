/**
 * site-tweaks — 「平台改进专员」live_fix 的持久化层
 *
 * 改进专员当场给出的展示层修复（改文案/隐藏/样式）由前端即时应用，
 * 并落盘到 data/site-tweaks.json：应用启动时随页面加载统一重放，
 * 让修复对全部用户生效（而不只是提意见的人当场看到）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SiteTweak {
  id: string;
  type: "text" | "hide" | "style";
  selector: string;
  value?: string;
  /** 改进专员的原话（来源说明） */
  reason?: string;
  createdBy: string;
  createdAt: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "../data/site-tweaks.json");

export function listTweaks(): SiteTweak[] {
  try {
    if (!existsSync(DATA_FILE)) return [];
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as SiteTweak[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function addTweak(t: Omit<SiteTweak, "id" | "createdAt">): SiteTweak {
  const tweaks = listTweaks();
  const row: SiteTweak = { ...t, id: `tw-${Date.now().toString(36)}`, createdAt: new Date().toISOString() };
  tweaks.push(row);
  persist(tweaks);
  return row;
}

export function removeTweak(id: string): boolean {
  const tweaks = listTweaks();
  const next = tweaks.filter((t) => t.id !== id);
  if (next.length === tweaks.length) return false;
  persist(next);
  return true;
}

function persist(tweaks: SiteTweak[]): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(tweaks, null, 2), "utf-8");
}
