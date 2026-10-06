/**
 * identity-manager — 人员身份自动匹配 + 「身份对齐」审查页后端
 *
 * 目标（2026-09-30 与用户对齐）：先全自动匹配（Gitea 组织成员 + 飞书通讯录 ×
 * 花名册别名打分），再在智悦平台页面让用户逐一核对——自动命中的绑定为 auto
 * 待确认，人工采纳/手填的绑定为 manual；auto 永不覆盖 manual。
 *
 * 数据落盘：config/timem-team-registry.json（$schema 同目录）。运行中的
 * 项目小助理按 mtime 自动重载，无需重启。
 * 候选拉取：
 *   - Gitea：/orgs/{org}/members（组织来自 project-registry 的仓库/组织字段）
 *   - 飞书：contact/v3 通讯录（需应用开通通讯录权限，失败如实降级为仅 Gitea 匹配）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import {
  buildGiteaUrl,
  loadGiteaToken,
  readGiteaEnv,
  resolveHostIp,
} from "@aigility-harness/layer-action";
import {
  axisIds,
  bindIdentityAxis,
  findMemberByAxis,
  getProjectRegistry,
  normalizeMember,
  persistIdentityRegistry,
  registryOrgs,
  scoreIdentityCandidates,
  unbindIdentityAxis,
  type IdentityAxis,
  type IdentityCandidate,
  type IdentityRegistryFile,
} from "@aigility-harness/layer-orchestration";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function registryPath(): string {
  return process.env.TEAM_IDENTITY_REGISTRY || resolve(REPO_ROOT, "config", "timem-team-registry.json");
}

/** 读全量登记表（含未 normalize 的原始成员字段，写回时保持形状） */
function loadFile(): IdentityRegistryFile {
  const path = registryPath();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as IdentityRegistryFile;
    if (!Array.isArray(raw.members)) raw.members = [];
    return raw;
  }
  return { version: 2, updated_at: new Date().toISOString(), members: [] };
}

/** 仓库根 .env 单键读取（与被管模块同源语义） */
function readEnvValue(key: string): string | undefined {
  try {
    const content = readFileSync(resolve(process.env.DOTENV_FILE || resolve(REPO_ROOT, ".env")), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim();
    }
  } catch { /* 无 .env */ }
  return undefined;
}

// ── Gitea（复用 @action/gitea-api 固化的 DNS 绕行 + token 经验） ──

async function giteaGet(
  path: string,
  query?: Record<string, string | number | boolean>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const env = readGiteaEnv();
  const url = buildGiteaUrl(env.baseUrl, path, query);
  try {
    const [token, ip] = await Promise.all([
      loadGiteaToken(env),
      resolveHostIp(new URL(url).hostname, env.dnsServer, env.fallbackIp),
    ]);
    const { status, text } = await new Promise<{ status: number; text: string }>((resolvePromise, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "GET",
          headers: { authorization: `token ${token}`, accept: "application/json" },
          lookup: (_host, opts, cb) =>
            opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4),
          signal: AbortSignal.timeout(15_000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}` };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── 飞书（tenant token，仅读通讯录；缺权限时降级） ───────────────

async function feishuTenantToken(): Promise<string> {
  const appId = readEnvValue("FEISHU_APP_ID") ?? "";
  const appSecret = readEnvValue("FEISHU_APP_SECRET") ?? "";
  if (!appId || !appSecret) throw new Error("缺少 FEISHU_APP_ID/FEISHU_APP_SECRET（仓库根 .env）");
  const resp = (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json())) as { code?: number; msg?: string; tenant_access_token?: string };
  if (resp.code !== 0 || !resp.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败（code=${resp.code}）：${resp.msg ?? "未知"}`);
  }
  return resp.tenant_access_token;
}

interface FeishuUser {
  openId: string;
  name: string;
}

/** 拉飞书通讯录（根部门直查；失败抛错由调用方降级） */
async function fetchFeishuUsers(): Promise<FeishuUser[]> {
  const token = await feishuTenantToken();
  const resp = (await fetch(
    "https://open.feishu.cn/open-apis/contact/v3/users/find_by_department?department_id=0&page_size=50&user_id_type=open_id",
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  ).then((r) => r.json())) as {
    code?: number;
    msg?: string;
    data?: { items?: Array<{ open_id?: string; name?: string }> };
  };
  if (resp.code !== 0) {
    throw new Error(`通讯录读取失败（code=${resp.code}）：${resp.msg ?? "未知"}（需开通「获取通讯录基本信息」权限）`);
  }
  return (resp.data?.items ?? [])
    .filter((u) => u.open_id)
    .map((u) => ({ openId: u.open_id as string, name: u.name ?? "" }));
}

// ── 候选汇总与自动匹配 ───────────────────────────────────────────

export interface IdentityCandidateView extends IdentityCandidate {
  source: "gitea" | "feishu";
  org?: string;
}

export interface IdentitySuggestion {
  member_id: string;
  axis: Exclude<IdentityAxis, "timem">;
  id: string;
  name?: string;
  score: number;
  reason: string;
}

export interface IdentityOverview {
  ok: boolean;
  /** 每个成员的可见视图（含 match_source） */
  members: Array<ReturnType<typeof normalizeMember>>;
  /** 候选池（gitea members + feishu contacts，已标注来源） */
  candidates: IdentityCandidateView[];
  /** 未自动绑定、达推荐阈值的候选（供页面一键采纳） */
  suggestions: IdentitySuggestion[];
  /** 飞书通讯录读取失败原因（可读时为空） */
  feishu_error?: string;
  orgs: string[];
}

/** 自动绑定的分数门槛（≥70=名称完全/互相包含命中；50-69 只做人工建议） */
const AUTO_BIND_SCORE = 70;
/** 建议展示门槛 */
const SUGGEST_SCORE = 50;

async function collectCandidates(): Promise<{ candidates: IdentityCandidateView[]; feishuError?: string }> {
  const orgs = registryOrgs(getProjectRegistry());
  const candidates: IdentityCandidateView[] = [];
  for (const org of orgs) {
    const r = await giteaGet(`/api/v1/orgs/${org}/members`, { limit: 50 });
    if (!r.ok || !Array.isArray(r.data)) continue;
    for (const m of r.data as Array<{ login?: string; full_name?: string; name?: string }>) {
      if (!m.login) continue;
      candidates.push({ id: m.login, name: m.full_name || m.name || undefined, source: "gitea", org });
    }
  }
  let feishuError: string | undefined;
  try {
    for (const u of await fetchFeishuUsers()) {
      candidates.push({ id: u.openId, name: u.name || undefined, source: "feishu" });
    }
  } catch (e) {
    feishuError = String(e instanceof Error ? e.message : e);
  }
  return { candidates, feishuError };
}

function buildSuggestions(
  file: IdentityRegistryFile,
  candidates: IdentityCandidateView[],
): IdentitySuggestion[] {
  const out: IdentitySuggestion[] = [];
  const taken = new Set<string>();
  for (const raw of file.members) {
    const m = normalizeMember(raw);
    for (const axis of ["feishu", "gitea"] as const) {
      for (const id of axisIds(m, axis)) taken.add(`${axis}:${id.toLowerCase()}`);
    }
  }
  for (const raw of file.members) {
    const m = normalizeMember(raw);
    for (const axis of ["feishu", "gitea"] as const) {
      if (axisIds(m, axis).length > 0) continue; // 已绑定的轴不再推荐
      const pool = candidates.filter((c) => c.source === axis);
      const top = scoreIdentityCandidates(m, pool)[0];
      if (!top || top.score < SUGGEST_SCORE) continue;
      if (taken.has(`${axis}:${top.candidate.id.toLowerCase()}`)) continue;
      out.push({
        member_id: m.member_id,
        axis,
        id: top.candidate.id,
        name: top.candidate.name,
        score: top.score,
        reason: top.reason,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 概览：成员视图 + 候选池 + 推荐建议（页面数据源） */
export async function identityOverview(): Promise<IdentityOverview> {
  const file = loadFile();
  const { candidates, feishuError } = await collectCandidates();
  return {
    ok: true,
    members: file.members.map(normalizeMember),
    candidates,
    suggestions: buildSuggestions(file, candidates),
    ...(feishuError ? { feishu_error: feishuError } : {}),
    orgs: registryOrgs(getProjectRegistry()),
  };
}

export interface AutoMatchResult {
  ok: boolean;
  /** 本轮自动绑定的条目（标记 auto，待人工在页面确认） */
  bound: Array<{ member_id: string; name: string; axis: Exclude<IdentityAxis, "timem">; id: string; score: number; reason: string }>;
  /** 达建议门槛但未自动绑定的（分低或已占用） */
  suggestions: IdentitySuggestion[];
  feishu_error?: string;
}

/**
 * 一键自动匹配：只对「该轴无绑定」的成员生效，命中 ≥AUTO_BIND_SCORE 写为
 * auto 绑定；auto 绑定可被下一轮自动匹配改写（manual 永不被触碰）。
 */
export async function runIdentityAutoMatch(): Promise<AutoMatchResult> {
  const file = loadFile();
  const { candidates, feishuError } = await collectCandidates();
  const bound: AutoMatchResult["bound"] = [];
  const occupied = new Map<string, string>(); // axis:id → member_id

  for (const raw of file.members) {
    const m = normalizeMember(raw);
    for (const axis of ["feishu", "gitea"] as const) {
      for (const id of axisIds(m, axis)) {
        if ((raw.match_source?.[axis] ?? "manual") === "manual") occupied.set(`${axis}:${id.toLowerCase()}`, m.member_id);
      }
    }
  }

  for (const raw of file.members) {
    const m = normalizeMember(raw);
    for (const axis of ["feishu", "gitea"] as const) {
      const existingSource = raw.match_source?.[axis];
      if (axisIds(m, axis).length > 0 && existingSource !== "auto") continue; // manual/已有绑定不动
      const pool = candidates.filter((c) => c.source === axis);
      const top = scoreIdentityCandidates(m, pool)[0];
      if (!top || top.score < AUTO_BIND_SCORE) continue;
      const key = `${axis}:${top.candidate.id.toLowerCase()}`;
      const owner = occupied.get(key);
      if (owner && owner !== m.member_id) continue;
      try {
        // auto 重绑先清掉旧 auto 绑定（防改绑后残留）
        if (axisIds(m, axis).length > 0) {
          for (const old of [...axisIds(m, axis)]) unbindIdentityAxis(file, m.member_id, axis, old);
        }
        bindIdentityAxis(file, m.member_id, axis, top.candidate.id, "auto");
        occupied.set(key, m.member_id);
        bound.push({ member_id: m.member_id, name: m.name, axis, id: top.candidate.id, score: top.score, reason: top.reason });
      } catch {
        // 冲突（已被人工绑给他人）跳过，等页面处理
      }
    }
  }

  if (bound.length > 0) persistIdentityRegistry(registryPath(), file);
  return {
    ok: true,
    bound,
    suggestions: buildSuggestions(file, candidates),
    ...(feishuError ? { feishu_error: feishuError } : {}),
  };
}

export interface IdentityBindRequest {
  memberId: string;
  axis: IdentityAxis;
  id: string;
  op: "bind" | "unbind" | "confirm";
}

/** 人工操作：绑定/解绑/确认（bind 与 confirm 都把来源标记为 manual） */
export function identityBind(req: IdentityBindRequest): { ok: boolean; error?: string } {
  const file = loadFile();
  try {
    if (req.op === "bind") {
      bindIdentityAxis(file, req.memberId, req.axis, req.id, "manual");
    } else if (req.op === "unbind") {
      unbindIdentityAxis(file, req.memberId, req.axis, req.id);
    } else if (req.op === "confirm") {
      const member = file.members.find((m) => m.member_id === req.memberId);
      if (!member) return { ok: false, error: `未找到成员: ${req.memberId}` };
      const ids = axisIds(member, req.axis);
      if (ids.length === 0) return { ok: false, error: "该轴没有绑定，无需确认" };
      member.match_source = { ...(member.match_source ?? {}), [req.axis]: "manual" };
    } else {
      return { ok: false, error: `未知操作: ${req.op}` };
    }
    persistIdentityRegistry(registryPath(), file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 查重助手：该身份是否已被他人占用（页面绑定前提示用） */
export function identityOwner(axis: IdentityAxis, id: string): { memberId: string; name: string } | undefined {
  const owner = findMemberByAxis(loadFile(), axis, id);
  return owner ? { memberId: owner.member_id, name: owner.name } : undefined;
}
