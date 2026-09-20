/**
 * 教师备课夹 · 服务端装配 (复刻 police_academy 教师备课功能线 → AppBase 体系)
 *
 * 与「班主任小本本」同构: 平台账号 (cookie/bearer 双轨) + 数据空间 (备课组) + 应用级 LLM 配置。
 * 业务分工:
 *   - 角色域: @persona/lesson-prep-chat 备课问答 (提示词/流内 TiMEM 记忆), 本模块只鉴权转发
 *   - 认知域: @cognitive/llm-inference 教案/材料生成 (只依据教材切片, 请求级 upstream 覆盖)
 *   - 行动域: @action/doc-worker Word 导出 (mdToBlocks 确定性转换, 本模块不做内容创作)
 *   - 本模块: 空间鉴权 + 课程/章节/教材切片/教案/材料存储 (PG) + 异步教案队列 + 导出编排
 *
 * 承袭源项目铁律: 零切片显式失败 (防空壳教案假成功); 降级产物必须打 degraded=true;
 * 异步教案「排队返回 plan_id + 后台逐章生成 + 增量落库 + 前端轮询」, 僵尸行 20 分钟自愈。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { json, readBody, pool, pageUserId, isAdminUser, emailOf } from "./admin-modules/context.js";
import { getAdminKernel } from "./admin-modules/kernel-ref.js";
import type { Result } from "@aigility-harness/core";
import type { LlmInferenceRequest, LlmInferenceResponse } from "@aigility-harness/layer-cognitive";
import type { DocWorkerRequest, DocWorkerResponse } from "@aigility-harness/layer-action";
import {
  LP_TEMPLATES,
  chunkText,
  stripCodeFence,
  planSystemPrompt,
  planUserPrompt,
  fallbackPlanBody,
  assembleWholeBook,
  materialSystemPrompt,
  materialUserPrompt,
  fallbackMaterialBody,
  withSourcesSection,
  mdToBlocks,
  MATERIAL_TYPES,
  templateOf,
  type ChunkRef,
  type PlanSource,
} from "./lesson-prep-core.js";

const APP_ID = "lesson-prep.html";
/** 整册教案 generation 僵尸自愈阈值 (承袭源项目 20 分钟) */
const ZOMBIE_MINUTES = 20;
/** 单章生成并发度 (承袭源项目 3 路) */
const CHAPTER_CONCURRENCY = 3;

// ── 建表 (幂等) ──────────────────────────────────────────────────

export async function initLessonPrep(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lp_courses (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (space_id, name)
    );
    CREATE TABLE IF NOT EXISTS lp_chapters (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL,
      course_id   TEXT NOT NULL REFERENCES lp_courses(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (course_id, name)
    );
    CREATE TABLE IF NOT EXISTS lp_chunks (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL,
      course_id   TEXT NOT NULL REFERENCES lp_courses(id) ON DELETE CASCADE,
      chapter     TEXT NOT NULL,
      doc_name    TEXT NOT NULL DEFAULT '教材',
      seq         INTEGER NOT NULL DEFAULT 0,
      content     TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lp_chunks_course ON lp_chunks(course_id, chapter);
    CREATE TABLE IF NOT EXISTS lp_plans (
      id           TEXT PRIMARY KEY,
      space_id     TEXT NOT NULL,
      course_id    TEXT NOT NULL REFERENCES lp_courses(id) ON DELETE CASCADE,
      chapter      TEXT NOT NULL DEFAULT '',
      scope        TEXT NOT NULL DEFAULT 'course',
      template     TEXT NOT NULL DEFAULT 'standard',
      title        TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      sources      JSONB NOT NULL DEFAULT '[]'::jsonb,
      degraded     BOOLEAN NOT NULL DEFAULT false,
      status       TEXT NOT NULL DEFAULT 'generating',
      created_by   TEXT NOT NULL,
      created_by_email TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lp_plans_space ON lp_plans(space_id, created_at);
    CREATE TABLE IF NOT EXISTS lp_materials (
      id           TEXT PRIMARY KEY,
      space_id     TEXT NOT NULL,
      course_id    TEXT NOT NULL REFERENCES lp_courses(id) ON DELETE CASCADE,
      chapter      TEXT NOT NULL,
      mtype        TEXT NOT NULL,
      title        TEXT NOT NULL,
      content_md   TEXT NOT NULL DEFAULT '',
      sources      JSONB NOT NULL DEFAULT '[]'::jsonb,
      degraded     BOOLEAN NOT NULL DEFAULT false,
      created_by   TEXT NOT NULL,
      created_by_email TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lp_materials_space ON lp_materials(space_id, created_at);
  `);
}

// ── 通用工具 ─────────────────────────────────────────────────────

type SpaceRole = "owner" | "member";

/** 空间访问权: owner(全权) / member(备课成员) / null(无权或不存在) */
async function spaceAccess(uid: string, spaceId: string): Promise<SpaceRole | null> {
  const { rows } = await pool.query("SELECT owner_id FROM app_spaces WHERE id = $1", [spaceId]);
  if (rows.length === 0) return null;
  if (rows[0].owner_id === uid) return "owner";
  const m = await pool.query(
    "SELECT 1 FROM app_space_members WHERE space_id = $1 AND user_id = $2", [spaceId, uid]);
  if (m.rowCount && m.rowCount > 0) return "member";
  return (await isAdminUser(uid)) ? "owner" : null;
}

/** 应用级 LLM 配置 (app_llm_config), 未配置回落全局 env; 均无 → null (调用方走降级) */
async function appLlmCfg(): Promise<{ url: string; key: string; model: string } | null> {
  const { rows } = await pool.query(
    "SELECT url, key, model FROM app_llm_config WHERE app_id = $1", [APP_ID]);
  if (rows[0]?.key) {
    return {
      url: rows[0].url || process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
      key: rows[0].key,
      model: rows[0].model || "",
    };
  }
  if (process.env.BIGMODEL_API_KEY) {
    return {
      url: process.env.BIGMODEL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
      key: process.env.BIGMODEL_API_KEY,
      model: process.env.LLM_MODEL || "glm-4.6",
    };
  }
  return null;
}

/** 单次 LLM 调用 (OpenAI Chat 内部标准); 失败返回 null, 调用方负责降级 */
async function llmText(uid: string, system: string, user: string): Promise<string | null> {
  const kernel = getAdminKernel();
  if (!kernel) return null;
  const resolved = await kernel.registry.resolve({
    id: "@cognitive/llm-inference", versionRange: "^1.0.0",
  });
  if (!resolved.ok) return null;
  const cfg = await appLlmCfg();
  const req: LlmInferenceRequest = {
    model: cfg?.model || process.env.LLM_MODEL || "glm-4.6",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
    ...(cfg ? { upstream: { url: cfg.url, key: cfg.key } } : {}),
  };
  try {
    const r = (await resolved.value.execute(req, kernel.createContext(
      `lesson-prep-${uid}`, "cognitive",
    ))) as Result<LlmInferenceResponse>;
    if (!r.ok || !r.value?.text) return null;
    return stripCodeFence(r.value.text);
  } catch {
    return null;
  }
}

/** 均匀采样 n 条切片 (章内切片多时避免只取开头) */
function pickSlices(rows: Array<{ id: string; doc_name: string; chapter: string; content: string }>, n: number): typeof rows {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  const out: typeof rows = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

/** 僵尸教案自愈: 超时仍 generating 的行置 failed (承袭源项目 lp_list 读时自愈) */
async function reapZombiePlans(): Promise<void> {
  await pool.query(
    `UPDATE lp_plans SET status = 'failed',
       content = COALESCE(NULLIF(content, ''),
         '# 教案生成超时\n\n后台任务超过 ' || $1::text || ' 分钟未完成, 已自动标记失败, 请重试。')
     WHERE status = 'generating' AND created_at < now() - make_interval(mins => $1::int)`,
    [ZOMBIE_MINUTES],
  );
}

// ── 异步教案队列 ─────────────────────────────────────────────────

interface ChapterChunkRow {
  id: string; doc_name: string; chapter: string; content: string;
}

/** 后台逐章生成 (增量落库): 异常落 failed 并把原因写进 content, 不抛出 */
async function runPlan(planId: string): Promise<void> {
  try {
    const { rows: planRows } = await pool.query(
      "SELECT * FROM lp_plans WHERE id = $1", [planId]);
    const plan = planRows[0];
    if (!plan || plan.status !== "generating") return;
    const { rows: courseRows } = await pool.query(
      "SELECT name FROM lp_courses WHERE id = $1", [plan.course_id]);
    const course = courseRows[0]?.name ?? "";

    // 目标章节清单 (单章 scope 时只生成该章; 章必须存在)
    let chapters: string[];
    if (plan.scope === "chapter") {
      if (!plan.chapter) throw new Error("缺少章节参数");
      chapters = [plan.chapter];
    } else {
      const { rows: chRows } = await pool.query(
        "SELECT name FROM lp_chapters WHERE course_id = $1 ORDER BY sort, created_at", [plan.course_id]);
      chapters = chRows.map((r: any) => r.name);
      if (chapters.length === 0) throw new Error("该课程还没有章节, 请先在「教材」页创建章节并上传教材");
    }

    // 单章 scope: 零切片显式失败 (防空壳教案假成功)
    const chapterChunks = new Map<string, ChapterChunkRow[]>();
    const { rows: allChunks } = await pool.query(
      `SELECT id, doc_name, chapter, content FROM lp_chunks
       WHERE course_id = $1 ORDER BY chapter, seq, created_at`, [plan.course_id]);
    for (const ch of chapters) {
      chapterChunks.set(ch, allChunks.filter((c: any) => c.chapter === ch));
    }
    if (plan.scope === "chapter" && (chapterChunks.get(chapters[0]) ?? []).length === 0) {
      throw new Error(`「${chapters[0]}」没有教材切片, 请先在「教材」页上传教材`);
    }

    const bodies = new Map<string, string>();
    const usedSources: PlanSource[] = [];
    let anyDegraded = false;
    let cursor = 0;

    const persist = async (doneCount: number) => {
      const assembled = plan.scope === "chapter"
        ? (bodies.get(chapters[0]) ?? "")
        : assembleWholeBook(
            course,
            chapters.map((ch) => ({ chapter: ch, body: bodies.get(ch) ?? "", done: bodies.has(ch) })),
            plan.template,
          );
      await pool.query(
        "UPDATE lp_plans SET content = $2, sources = $3::jsonb, degraded = $4, updated_at = now() WHERE id = $1",
        [planId, assembled, JSON.stringify(usedSources.slice(0, 30)), anyDegraded]);
      void doneCount;
    };

    const genChapter = async (ch: string) => {
      const chunks = chapterChunks.get(ch) ?? [];
      if (chunks.length === 0) {
        bodies.set(ch, fallbackPlanBody(course, ch, plan.template, []));
        anyDegraded = true;
        return;
      }
      const sampled = pickSlices(chunks, 6);
      for (const s of sampled.slice(0, 4)) {
        usedSources.push({ chunk_id: s.id, doc_name: s.doc_name, chapter: s.chapter });
      }
      const slices: ChunkRef[] = sampled.map((s) => ({ doc_name: s.doc_name, chapter: s.chapter, content: s.content }));
      const text = await llmText(plan.created_by, planSystemPrompt(plan.template), planUserPrompt(course, ch, slices));
      if (text && text.trim().length > 60) {
        bodies.set(ch, stripCodeFence(text));
      } else {
        bodies.set(ch, fallbackPlanBody(course, ch, plan.template, slices));
        anyDegraded = true;
      }
      cursor += 1;
      await persist(cursor);
    };

    // 受限并发: 逐章生成, 每完成一章增量落库 (轮询可见字数增长)
    let next = 0;
    const worker = async () => {
      while (next < chapters.length) {
        const ch = chapters[next++];
        await genChapter(ch);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHAPTER_CONCURRENCY, chapters.length) }, worker),
    );

    await persist(chapters.length);
    await pool.query(
      "UPDATE lp_plans SET status = 'ready', title = $2, updated_at = now() WHERE id = $1",
      [planId, plan.scope === "chapter" ? `${course}·${chapters[0]}教案` : `${course}·整册教案`]);
  } catch (e: any) {
    const reason = String(e?.message ?? e);
    await pool.query(
      `UPDATE lp_plans SET status = 'failed', degraded = false, updated_at = now(),
         content = CASE WHEN content <> '' THEN content ELSE '# 教案生成失败\n\n' || $2 END
       WHERE id = $1`,
      [planId, `原因: ${reason}`],
    ).catch(() => {});
  }
}

// ── 导出 (Word 走 @action/doc-worker) ────────────────────────────

async function exportDocx(res: ServerResponse, uid: string, title: string, meta: string, md: string): Promise<void> {
  const kernel = getAdminKernel();
  if (!kernel) return json(res, 503, { error: "内核未就绪" });
  const resolved = await kernel.registry.resolve({ id: "@action/doc-worker", versionRange: "^1.0.0" });
  if (!resolved.ok) return json(res, 503, { error: resolved.error || "文档工人能力未注册" });
  const email = await safeEmail(uid);
  const req: DocWorkerRequest = {
    title,
    subtitle: meta,
    creator: email || "教师备课夹",
    blocks: mdToBlocks(md),
  };
  const r = (await resolved.value.execute(req, kernel.createContext(`lesson-prep-export-${uid}`, "action"))) as Result<DocWorkerResponse>;
  if (!r.ok) return json(res, 502, { error: r.error ?? "Word 导出失败" });
  return json(res, 200, { filename: r.value.filename, base64: r.value.base64 });
}

function safeEmail(uid: string): Promise<string> {
  return emailOf(uid).catch(() => "");
}

// ── 路由 ─────────────────────────────────────────────────────────

export async function lessonPrepHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const q = (k: string) => String(url.searchParams.get(k) ?? "");

  try {
    // ── 备课助理 (薄路由): 业务在角色域, 这里只鉴权与转发 (与 /app/banban/chat 同构) ──
    if (path === "/app/lesson-prep/chat" && method === "POST") {
      const uid = pageUserId(req);
      if (!uid) return json(res, 401, { error: "未授权: 请先登录" });
      const kernel = getAdminKernel();
      if (!kernel) return json(res, 503, { error: "内核未就绪" });
      const body = await readBody(req);
      const question = String(body.question ?? "").trim();
      if (!question) return json(res, 400, { error: "question 必填" });
      const chat = await kernel.registry.resolve({
        id: "@persona/lesson-prep-chat", versionRange: "^1.0.0",
      });
      if (!chat.ok) return json(res, 503, { error: chat.error || "备课助理能力未注册" });
      const r = await (chat.value as {
        execute: (req: unknown, ctx: unknown) => Promise<Result<{ response?: string; degraded?: boolean }>>;
      }).execute(
        {
          user_input: question,
          session_id: `lesson-prep-${uid}`,
          user_key: await emailOf(uid),
          course_context: String(body.context ?? "").slice(0, 12000),
          history: Array.isArray(body.history) ? body.history.slice(-12) : [],
        },
        kernel.createContext(`lesson-prep-chat-${uid}`, "persona"),
      );
      if (!r.ok) return json(res, 502, { error: r.error ?? "备课助理执行失败" });
      return json(res, 200, { response: r.value?.response ?? "", degraded: Boolean(r.value?.degraded) });
    }

    // ── 以下全部需要登录 + 空间成员身份 ──
    const uid = pageUserId(req);
    if (!uid) return json(res, 401, { error: "未授权: 请先登录" });

    if (method === "GET" && path === "/app/lesson-prep/templates") {
      return json(res, 200, {
        items: LP_TEMPLATES.map((t) => ({ key: t.key, label: t.label, sections: t.sections })),
        mtypes: MATERIAL_TYPES,
      });
    }

    // 空间鉴权 (chat/templates 之外都要 space)
    const spaceId = q("space") || "";
    if (!spaceId) return json(res, 400, { error: "缺少 space 参数" });
    const role = await spaceAccess(uid, spaceId);
    if (!role) return json(res, 403, { error: "你不是该备课组的成员, 请联系负责人添加" });

    // ── 课程 ──
    if (path === "/app/lesson-prep/courses" && method === "GET") {
      const { rows } = await pool.query(
        `SELECT c.id, c.name, c.description, c.created_by, c.created_by_email, c.created_at,
                (SELECT count(*)::int FROM lp_chapters ch WHERE ch.course_id = c.id) AS chapter_count,
                (SELECT count(*)::int FROM lp_chunks k WHERE k.course_id = c.id) AS chunk_count,
                (SELECT count(*)::int FROM lp_plans p WHERE p.course_id = c.id AND p.status = 'ready') AS plan_ready,
                (SELECT count(*)::int FROM lp_plans p WHERE p.course_id = c.id AND p.status = 'generating') AS plan_running,
                (SELECT count(DISTINCT p.chapter)::int FROM lp_plans p WHERE p.course_id = c.id AND p.status = 'ready' AND p.scope = 'chapter') AS chapter_planned,
                (SELECT count(*)::int FROM lp_materials m WHERE m.course_id = c.id) AS material_count
         FROM lp_courses c WHERE c.space_id = $1 ORDER BY c.created_at`,
        [spaceId],
      );
      const items = rows.map((r: any) => ({
        ...r,
        prep_ratio: r.chapter_count > 0 ? Math.round((r.chapter_planned / r.chapter_count) * 100) : 0,
        mine: r.created_by === uid,
      }));
      return json(res, 200, { items, my_role: role });
    }
    if (path === "/app/lesson-prep/courses" && method === "POST") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) return json(res, 400, { error: "课程名必填" });
      const id = randomUUID();
      await pool.query(
        `INSERT INTO lp_courses (id, space_id, name, description, created_by, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (space_id, name) DO NOTHING`,
        [id, spaceId, name, String(body.description ?? "").trim(), uid, await emailOf(uid)],
      );
      const { rows: cur } = await pool.query("SELECT id FROM lp_courses WHERE space_id = $1 AND name = $2", [spaceId, name]);
      return json(res, 201, { id: cur[0]?.id ?? id });
    }
    const courseMatch = path.match(/^\/app\/lesson-prep\/courses\/([^/]+)$/);
    if (courseMatch && method === "DELETE") {
      if (role !== "owner") return json(res, 403, { error: "仅备课组负责人可删除课程" });
      const { rowCount } = await pool.query(
        "DELETE FROM lp_courses WHERE id = $1 AND space_id = $2", [decodeURIComponent(courseMatch[1]), spaceId]);
      if (!rowCount) return json(res, 404, { error: "课程不存在" });
      return json(res, 200, { ok: true });
    }

    // 课程存在性 + 归属校验 (后续路由共用)
    const requireCourse = async (courseId: string): Promise<string | null> => {
      const { rows } = await pool.query(
        "SELECT id, name FROM lp_courses WHERE id = $1 AND space_id = $2", [courseId, spaceId]);
      return rows[0]?.name ?? null;
    };

    // ── 章节 ──
    if (path === "/app/lesson-prep/chapters" && method === "GET") {
      const courseId = q("course");
      const { rows } = await pool.query(
        `SELECT ch.id, ch.name, ch.sort,
                (SELECT count(*)::int FROM lp_chunks k WHERE k.course_id = ch.course_id AND k.chapter = ch.name) AS chunk_count
         FROM lp_chapters ch WHERE ch.course_id = $1 AND ch.space_id = $2 ORDER BY ch.sort, ch.created_at`,
        [courseId, spaceId],
      );
      return json(res, 200, { items: rows });
    }
    if (path === "/app/lesson-prep/chapters" && method === "POST") {
      const body = await readBody(req);
      const name = String(body.name ?? "").trim();
      if (!name) return json(res, 400, { error: "章节名必填" });
      if (!(await requireCourse(String(body.course ?? "")))) return json(res, 404, { error: "课程不存在" });
      const id = randomUUID();
      await pool.query(
        `INSERT INTO lp_chapters (id, space_id, course_id, name, sort)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (course_id, name) DO NOTHING`,
        [id, spaceId, String(body.course), name, Number(body.sort ?? 0)],
      );
      const { rows: cur } = await pool.query(
        "SELECT id FROM lp_chapters WHERE course_id = $1 AND name = $2", [String(body.course), name]);
      return json(res, 201, { id: cur[0]?.id ?? id });
    }
    const chapterMatch = path.match(/^\/app\/lesson-prep\/chapters\/([^/]+)$/);
    if (chapterMatch) {
      const chId = decodeURIComponent(chapterMatch[1]);
      if (method === "PUT") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) return json(res, 400, { error: "章节名必填" });
        // 章节重命名: 同步迁移教材切片的 chapter 标记 (承袭源项目 /chapters/rename 语义)
        const { rows: chRow } = await pool.query(
          "SELECT name FROM lp_chapters WHERE id = $1 AND space_id = $2", [chId, spaceId]);
        if (!chRow.length) return json(res, 404, { error: "章节不存在" });
        await pool.query("UPDATE lp_chapters SET name = $2 WHERE id = $1", [chId, name]);
        await pool.query(
          "UPDATE lp_chunks SET chapter = $2 WHERE course_id = (SELECT course_id FROM lp_chapters WHERE id = $1) AND chapter = $3",
          [chId, name, chRow[0].name],
        );
        return json(res, 200, { ok: true });
      }
      if (method === "DELETE") {
        await pool.query("DELETE FROM lp_chunks WHERE course_id = (SELECT course_id FROM lp_chapters WHERE id = $1) AND chapter = (SELECT name FROM lp_chapters WHERE id = $1)", [chId]);
        const { rowCount } = await pool.query(
          "DELETE FROM lp_chapters WHERE id = $1 AND space_id = $2", [chId, spaceId]);
        if (!rowCount) return json(res, 404, { error: "章节不存在" });
        return json(res, 200, { ok: true });
      }
    }

    // ── 教材切片 ──
    if (path === "/app/lesson-prep/chunks" && method === "GET") {
      const { rows } = await pool.query(
        `SELECT id, chapter, doc_name, seq, left(content, 80) AS preview, created_at
         FROM lp_chunks WHERE course_id = $1 AND space_id = $2 AND chapter = $3
         ORDER BY seq, created_at`,
        [q("course"), spaceId, q("chapter")],
      );
      return json(res, 200, { items: rows });
    }
    if (path === "/app/lesson-prep/chunks" && method === "POST") {
      const body = await readBody(req);
      const courseId = String(body.course ?? "");
      const chapter = String(body.chapter ?? "").trim();
      const text = String(body.text ?? "");
      if (!(await requireCourse(courseId))) return json(res, 404, { error: "课程不存在" });
      if (!chapter) return json(res, 400, { error: "章节必填" });
      if (!text.trim()) return json(res, 400, { error: "教材文本必填" });
      const pieces = chunkText(text);
      if (pieces.length === 0) return json(res, 400, { error: "未能从文本中切出任何内容" });
      const docName = String(body.docName ?? "").trim() || `${chapter}·教材`;
      const { rows: seqRow } = await pool.query(
        "SELECT COALESCE(MAX(seq), 0)::int AS max_seq FROM lp_chunks WHERE course_id = $1 AND chapter = $2",
        [courseId, chapter],
      );
      let seq = seqRow[0]?.max_seq ?? 0;
      const email = await emailOf(uid);
      for (const piece of pieces) {
        seq += 1;
        await pool.query(
          `INSERT INTO lp_chunks (id, space_id, course_id, chapter, doc_name, seq, content, created_by, created_by_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), spaceId, courseId, chapter, docName, seq, piece, uid, email],
        );
      }
      return json(res, 201, { chunks: pieces.length });
    }
    const chunkMatch = path.match(/^\/app\/lesson-prep\/chunks\/([^/]+)$/);
    if (chunkMatch && method === "DELETE") {
      const { rowCount } = await pool.query(
        "DELETE FROM lp_chunks WHERE id = $1 AND space_id = $2", [decodeURIComponent(chunkMatch[1]), spaceId]);
      if (!rowCount) return json(res, 404, { error: "切片不存在" });
      return json(res, 200, { ok: true });
    }

    // ── 教案 ──
    if (path === "/app/lesson-prep/plans" && method === "GET") {
      await reapZombiePlans();
      const courseId = q("course");
      const { rows } = await pool.query(
        `SELECT id, title, chapter, scope, template, degraded, status, created_by, created_by_email,
                length(content) AS content_chars, created_at
         FROM lp_plans WHERE space_id = $1 ${courseId ? "AND course_id = $2" : ""}
         ORDER BY created_at DESC LIMIT 50`,
        courseId ? [spaceId, courseId] : [spaceId],
      );
      return json(res, 200, {
        items: rows.map((r: any) => ({ ...r, plan_id: r.id, mine: r.created_by === uid })),
      });
    }
    if (path === "/app/lesson-prep/plans" && method === "POST") {
      const body = await readBody(req);
      const courseId = String(body.course ?? "");
      const scope = body.scope === "chapter" ? "chapter" : "course";
      const chapter = String(body.chapter ?? "").trim();
      const template = templateOf(String(body.template ?? "standard")).key;
      const courseName = await requireCourse(courseId);
      if (!courseName) return json(res, 404, { error: "课程不存在" });
      if (scope === "chapter" && !chapter) return json(res, 400, { error: "单章模式必须选择章节" });
      const id = randomUUID();
      const title = scope === "chapter" ? `${courseName}·${chapter}教案` : `${courseName}·整册教案`;
      await pool.query(
        `INSERT INTO lp_plans (id, space_id, course_id, chapter, scope, template, title, status, created_by, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'generating',$8,$9)`,
        [id, spaceId, courseId, scope === "chapter" ? chapter : "", scope, template, title, uid, await emailOf(uid)],
      );
      void runPlan(id); // 后台生成, 前端轮询 GET /plans/:id
      return json(res, 202, { plan_id: id, title, status: "generating", queued: true });
    }
    const planMatch = path.match(/^\/app\/lesson-prep\/plans\/([^/]+)(?:\/export)?$/);
    if (planMatch) {
      const planId = decodeURIComponent(planMatch[1]);
      const { rows } = await pool.query("SELECT * FROM lp_plans WHERE id = $1 AND space_id = $2", [planId, spaceId]);
      const plan = rows[0];
      if (!plan) return json(res, 404, { error: "教案不存在" });

      if (path.endsWith("/export") && method === "GET") {
        await reapZombiePlans();
        const { rows: cur } = await pool.query("SELECT * FROM lp_plans WHERE id = $1", [planId]);
        const fmt = q("fmt") || "docx";
        const md = withSourcesSection(cur[0].content, cur[0].sources ?? []);
        if (fmt === "md") return json(res, 200, { filename: `${cur[0].title}.md`, content: md });
        const meta = `课程备课产物 · ${cur[0].scope === "chapter" ? "单章" : "整册"} · 溯源 ${((cur[0].sources ?? []) as unknown[]).length} 条切片`;
        return exportDocx(res, uid, cur[0].title, meta, md);
      }
      if (method === "GET") {
        await reapZombiePlans();
        const { rows: cur } = await pool.query("SELECT * FROM lp_plans WHERE id = $1", [planId]);
        const p = cur[0];
        return json(res, 200, {
          plan_id: p.id, title: p.title, chapter: p.chapter, scope: p.scope, template: p.template,
          content: p.content, sources: p.sources ?? [], degraded: p.degraded, status: p.status,
          created_by_email: p.created_by_email, created_at: p.created_at,
        });
      }
      if (method === "DELETE") {
        if (plan.created_by !== uid && role !== "owner") {
          return json(res, 403, { error: "只能删除自己的教案" });
        }
        await pool.query("DELETE FROM lp_plans WHERE id = $1", [planId]);
        return json(res, 200, { ok: true });
      }
    }

    // ── 四件套材料 ──
    if (path === "/app/lesson-prep/materials" && method === "GET") {
      const courseId = q("course");
      const mtype = q("mtype");
      const conds = ["space_id = $1"];
      const params: unknown[] = [spaceId];
      if (courseId) { params.push(courseId); conds.push(`course_id = $${params.length}`); }
      if (mtype) { params.push(mtype); conds.push(`mtype = $${params.length}`); }
      const { rows } = await pool.query(
        `SELECT id, chapter, mtype, title, degraded, created_by, created_by_email,
                length(content_md) AS content_chars, created_at
         FROM lp_materials WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT 100`,
        params,
      );
      return json(res, 200, { items: rows.map((r: any) => ({ ...r, mine: r.created_by === uid })) });
    }
    if (path === "/app/lesson-prep/materials" && method === "POST") {
      const body = await readBody(req);
      const courseId = String(body.course ?? "");
      const chapter = String(body.chapter ?? "").trim();
      const mtype = String(body.mtype ?? "").trim();
      const courseName = await requireCourse(courseId);
      if (!courseName) return json(res, 404, { error: "课程不存在" });
      if (!chapter) return json(res, 400, { error: "章节必填" });
      if (!MATERIAL_TYPES.includes(mtype as any)) {
        return json(res, 400, { error: `材料类型必须是 ${MATERIAL_TYPES.join("/")}` });
      }
      const { rows: chunkRows } = await pool.query(
        `SELECT id, doc_name, chapter, content FROM lp_chunks
         WHERE course_id = $1 AND chapter = $2 ORDER BY seq, created_at`,
        [courseId, chapter],
      );
      if (chunkRows.length === 0) {
        return json(res, 400, { error: `「${chapter}」没有教材切片, 请先在「教材」页上传教材` });
      }
      const slices = pickSlices(chunkRows, 8);
      const sources: PlanSource[] = slices.slice(0, 6).map((s) => ({
        chunk_id: s.id, doc_name: s.doc_name, chapter: s.chapter,
      }));
      const text = await llmText(uid, materialSystemPrompt(mtype), materialUserPrompt(courseName, chapter, mtype, slices));
      const degraded = !(text && text.trim().length > 60);
      const content = degraded ? fallbackMaterialBody(courseName, chapter, mtype, slices) : stripCodeFence(text!);
      const id = randomUUID();
      await pool.query(
        `INSERT INTO lp_materials (id, space_id, course_id, chapter, mtype, title, content_md, sources, degraded, created_by, created_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [id, spaceId, courseId, chapter, mtype, `${chapter}·${mtype}`, content,
         JSON.stringify(sources), degraded, uid, await emailOf(uid)],
      );
      return json(res, 201, { id, title: `${chapter}·${mtype}`, degraded });
    }
    const matMatch = path.match(/^\/app\/lesson-prep\/materials\/([^/]+)(?:\/export)?$/);
    if (matMatch) {
      const matId = decodeURIComponent(matMatch[1]);
      const { rows } = await pool.query("SELECT * FROM lp_materials WHERE id = $1 AND space_id = $2", [matId, spaceId]);
      const mat = rows[0];
      if (!mat) return json(res, 404, { error: "材料不存在" });

      if (path.endsWith("/export") && method === "GET") {
        const { rows: cur } = await pool.query("SELECT * FROM lp_materials WHERE id = $1", [matId]);
        const fmt = q("fmt") || "docx";
        const md = withSourcesSection(cur[0].content_md, cur[0].sources ?? []);
        if (fmt === "md") return json(res, 200, { filename: `${cur[0].title}.md`, content: md });
        const meta = `备课辅导材料 · ${cur[0].mtype} · 溯源 ${((cur[0].sources ?? []) as unknown[]).length} 条切片`;
        return exportDocx(res, uid, cur[0].title, meta, md);
      }
      if (method === "GET") {
        return json(res, 200, {
          id: mat.id, title: mat.title, chapter: mat.chapter, mtype: mat.mtype,
          content_md: mat.content_md, sources: mat.sources ?? [], degraded: mat.degraded,
          created_by_email: mat.created_by_email, created_at: mat.created_at,
        });
      }
      if (method === "DELETE") {
        if (mat.created_by !== uid && role !== "owner") {
          return json(res, 403, { error: "只能删除自己的材料" });
        }
        await pool.query("DELETE FROM lp_materials WHERE id = $1", [matId]);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: `lesson-prep: not found (${method} ${path})` });
  } catch (e: any) {
    console.error("[lesson-prep]", e);
    return json(res, 500, { error: `备课台服务错误: ${String(e?.message ?? e)}` });
  }
}
