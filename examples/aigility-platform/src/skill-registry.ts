/**
 * 智悦平台 · 已发布数字员工（技能）注册表
 *
 * 智能体工厂「发布」动作的落点：持久化到 examples/aigility-platform/data/aigility-skills.json。
 * 发布后的技能立即可对话 —— /api/aigility-chat 携带 skill_id 时，@persona/aigility-agent
 * 按注册表加载该技能的 Prompt/边界，走 workflow-engine 五域链路（记忆按技能隔离）。
 * 文件缺省时为空列表：无种子数据，数字员工由工厂自建（封装层不预置业务）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AigilitySkill {
  id: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  /** 推理模型（展示配置；v1 模型路由走全局 LLM 上游） */
  modelId: string;
  /** 角色 Prompt（智能体工厂第 2 步填写，发布后成为 system prompt 主体） */
  prompt: string;
  temperature: number;
  /** 挂载的知识库名（展示用；TiMEM 知识召回接真时转为知识库 id） */
  knowledge: string[];
  /** 挂载的工具名（展示用；工具执行接真时转为 @action/* 能力 id） */
  tools: string[];
  visibility: string;
  releaseNote: string;
  status: "已发布";
  updatedAt: string;
  usage: number;
  /** 发布者邮箱（visibility=仅自己 时的可见性判据；历史数据缺省视为 admin） */
  owner?: string;
}

export type AigilitySkillInput = Omit<AigilitySkill, "status" | "updatedAt" | "usage">;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "../data/aigility-skills.json");

let cache: AigilitySkill[] | null = null;

function loadFromDisk(): AigilitySkill[] {
  try {
    if (!existsSync(DATA_FILE)) return [];
    const raw: unknown = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    return Array.isArray(raw) ? (raw as AigilitySkill[]) : [];
  } catch {
    return [];
  }
}

function persist(skills: AigilitySkill[]): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(skills, null, 2), "utf-8");
}

export function listSkills(): AigilitySkill[] {
  if (!cache) cache = loadFromDisk();
  return cache;
}

/** 按查看者过滤可见技能：企业内全员可见；「仅自己」仅发布者（历史无主数据归 admin）可见 */
export function visibleSkills(userEmail?: string): AigilitySkill[] {
  const viewer = userEmail || "";
  return listSkills().filter((s) => {
    if (s.visibility !== "仅自己") return true;
    return (s.owner ?? "admin@aigility.local") === viewer;
  });
}

export function getSkill(id: string): AigilitySkill | undefined {
  return listSkills().find((s) => s.id === id);
}

export function upsertSkill(input: AigilitySkillInput): AigilitySkill {
  const skills = listSkills();
  const skill: AigilitySkill = {
    ...input,
    status: "已发布",
    updatedAt: new Date().toISOString().slice(0, 10),
    usage: 0,
  };
  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) skills[idx] = skill;
  else skills.unshift(skill);
  persist(skills);
  return skill;
}

/** 发布后补记 owner（visibility=仅自己 的可见性判据；写盘持久化） */
export function persistOwner(id: string, owner?: string): void {
  const skills = listSkills();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return;
  skill.owner = owner;
  persist(skills);
}

/** 可见范围单独更新（管理员上架/撤下市场）：企业内 = 上架市场，仅自己 = 撤下 */
export function setSkillVisibility(id: string, visibility: string): AigilitySkill | undefined {
  const skills = listSkills();
  const skill = skills.find((s) => s.id === id);
  if (!skill) return undefined;
  skill.visibility = visibility;
  persist(skills);
  return skill;
}

export function removeSkill(id: string): boolean {
  const skills = listSkills();
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  cache = next;
  persist(next);
  return true;
}

// ── 对话用量（data/aigility-usage.json 写穿落盘, 重启不丢；驾驶舱 skillUsage/butlerChats 来源） ──

const USAGE_FILE = resolve(__dirname, "../data/aigility-usage.json");
let usage: Map<string, number> | null = null;

function loadUsage(): Map<string, number> {
  if (usage) return usage;
  try {
    const raw: unknown = existsSync(USAGE_FILE) ? JSON.parse(readFileSync(USAGE_FILE, "utf-8")) : {};
    usage = new Map(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
    );
  } catch {
    usage = new Map();
  }
  return usage;
}

/** 数字员工对话计数（aigility-agent 每次对话调用; skill_id 缺省计 butler）。每次写穿落盘。 */
export function bumpSkillUsage(id: string): void {
  const m = loadUsage();
  m.set(id, (m.get(id) ?? 0) + 1);
  try {
    mkdirSync(dirname(USAGE_FILE), { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(m)), "utf-8");
  } catch {
    // 落盘失败不阻塞对话：计数保留在内存, 下次 bump 重试写穿
  }
}

export function usageSnapshot(): Record<string, number> {
  return Object.fromEntries(loadUsage());
}
