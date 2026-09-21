/**
 * 教师备课夹 · 备课纯逻辑核 (零依赖, 可单测)
 *
 * 复刻自 police_academy 教师备课功能线的确定性部分:
 *   - 四课型教案模板 (LP_TEMPLATES): 标准 / 实训 / 思政示范 / 复习
 *   - 教材分片 (chunkText): 段落感知切分, 供「只依据教材」生成与溯源
 *   - Prompt 构造: 教案 (整册/单章) + 四件套材料 (讲义/练习/要点卡/课件)
 *   - 模板降级 (fallback*): LLM 不可用/失败时的骨架拼接, 调用方必须打 degraded 标记
 *   - 整册拼装 (assembleWholeBook): 知识点总览 + 逐章小节
 *   - mdToBlocks: 教案 Markdown → @action/doc-worker 块模型 (Word 导出)
 *
 * 铁律 (承袭源项目): 生成只依据教材切片; 零切片显式失败 (防空壳教案假成功);
 * 降级产物与 AI 产物严格区分; 围栏剥离写读两侧都做。
 */

import type { DocBlock } from "@aigility-harness/layer-action";

// ── 四课型教案模板 ───────────────────────────────────────────────

export interface LessonPlanTemplate {
  key: "standard" | "practical" | "ideology" | "review";
  label: string;
  /** 注入 system prompt 的结构要求 */
  prompt: string;
  /** 降级骨架的章节清单 (导出/测试可感知) */
  sections: string[];
}

export const LP_TEMPLATES: LessonPlanTemplate[] = [
  {
    key: "standard",
    label: "标准教案",
    prompt: "教案须包含以下小节: 教学目标、重点难点、教学过程(引入-讲授-互动-小结)、作业布置、思政融入点。",
    sections: ["教学目标", "重点难点", "教学过程", "作业布置", "思政融入点"],
  },
  {
    key: "practical",
    label: "实训课教案",
    prompt: "教案须包含以下小节: 实训目标、场地器材与安全、实训流程(示范-演练-巡回指导-考核点评)、常见错误与纠正、考核标准、安全注意。",
    sections: ["实训目标", "场地器材与安全", "实训流程", "常见错误与纠正", "考核标准", "安全注意"],
  },
  {
    key: "ideology",
    label: "思政示范课教案",
    prompt: "教案须包含以下小节: 三维目标(知识/能力/价值)、思政元素挖掘、融入路径、教学过程、育人成效评价。",
    sections: ["三维目标", "思政元素挖掘", "融入路径", "教学过程", "育人成效评价"],
  },
  {
    key: "review",
    label: "复习课教案",
    prompt: "教案须包含以下小节: 复习目标、知识框架、高频考点与易错点、典型例题、巩固练习。",
    sections: ["复习目标", "知识框架", "高频考点与易错点", "典型例题", "巩固练习"],
  },
];

export function templateOf(key: string): LessonPlanTemplate {
  return LP_TEMPLATES.find((t) => t.key === key) ?? LP_TEMPLATES[0];
}

// ── 教材分片 ─────────────────────────────────────────────────────

/** 段落感知分片: 按空行/换行聚段, 超过 maxChars 的段再按句切; 返回非空片段序列 */
export function chunkText(text: string, maxChars = 800): string[] {
  const clean = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}|\n(?=[#>\-*\d])/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  for (const para of paras) {
    if (para.length > maxChars) {
      flush();
      // 长段按句切分
      const sentences = para.split(/(?<=[。!?；;])\s*/);
      let sub = "";
      for (const s of sentences) {
        if ((sub + s).length > maxChars && sub) {
          chunks.push(sub.trim());
          sub = s;
        } else {
          sub += s;
        }
      }
      if (sub.trim()) chunks.push(sub.trim());
      continue;
    }
    if ((buf + "\n\n" + para).length > maxChars && buf) flush();
    buf = buf ? buf + "\n\n" + para : para;
  }
  flush();
  return chunks;
}

// ── 围栏剥离 ─────────────────────────────────────────────────────

/** 剥离 LLM 偶发包住整篇输出的 ```markdown 围栏 */
export function stripCodeFence(text: string): string {
  const t = (text ?? "").trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return m ? m[1].trim() : t;
}

// ── 教案 Prompt ──────────────────────────────────────────────────

export interface ChunkRef {
  doc_name: string;
  chapter: string;
  content: string;
}

export const PLAN_SYSTEM_BASE =
  "你是警务院校课程教案撰写助手。依据给定教材片段撰写教案, 只依据教材内容, 不得编造教材中不存在的知识点或数据。";

export function planSystemPrompt(templateKey: string): string {
  return `${PLAN_SYSTEM_BASE} ${templateOf(templateKey).prompt} 用 Markdown 输出, 一级标题为教案题目, 小节用二级标题。`;
}

export function planUserPrompt(
  course: string,
  chapter: string,
  slices: ChunkRef[],
): string {
  const part = slices
    .slice(0, 6)
    .map((s) => `【${s.doc_name}·${s.chapter}】${s.content.slice(0, 300)}`)
    .join("\n---\n");
  return `课程：${course}${chapter ? `；章节：${chapter}` : "；范围：整册"}。\n教材片段：\n${part}\n\n请依据以上教材片段撰写${chapter ? `「${chapter}」一章的` : ""}教案。`;
}

// ── 教案降级骨架 ─────────────────────────────────────────────────

export function fallbackPlanBody(
  course: string,
  chapter: string,
  templateKey: string,
  slices: ChunkRef[],
): string {
  const tpl = templateOf(templateKey);
  const title = chapter ? `${course}·${chapter}教案（模板降级）` : `${course}·整册教案（模板降级）`;
  const excerpt = slices.slice(0, 4).map((s) => `- ${s.doc_name}·${s.chapter}：${s.content.slice(0, 120)}…`);
  return [
    `# ${title}`,
    "",
    "> 本教案由模板骨架生成（AI 暂不可用），内容为教材要点摘录, 请教师补充完善。",
    "",
    ...tpl.sections.map((sec) => `## ${sec}\n\n（请结合教材要点补充本节内容。）\n`),
    "## 教材要点摘录",
    "",
    ...(excerpt.length ? excerpt : ["（无教材切片）"]),
  ].join("\n");
}

// ── 整册拼装 ─────────────────────────────────────────────────────

/** 整册教案拼装: 标题 + 引导行 + 知识点总览 + 逐章小节 (增量落库时 chapterBodies 可含占位) */
export function assembleWholeBook(
  course: string,
  chapters: Array<{ chapter: string; body: string; done: boolean }>,
  templateKey: string,
): string {
  const tpl = templateOf(templateKey);
  const doneCount = chapters.filter((c) => c.done).length;
  const lines: string[] = [
    `# ${course}·整册教案（${tpl.label}）`,
    "",
    `> 覆盖 ${chapters.length} 章, 已生成 ${doneCount} 章; 全程只依据教材切片, 溯源见各章末尾。`,
    "",
    `## 课程结构总览`,
    "",
    ...chapters.map((c, i) => `${i + 1}. ${c.chapter}${c.done ? "" : "（生成中…）"}`),
    "",
  ];
  for (const c of chapters) {
    lines.push("---", "", c.body.trim(), "");
  }
  return lines.join("\n");
}

// ── 四件套材料 Prompt ────────────────────────────────────────────

export const MATERIAL_TYPES = ["讲义", "练习", "要点卡", "课件"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];

const MATERIAL_PROMPTS: Record<MaterialType, string> = {
  讲义: "撰写课堂讲义, 结构: 学习目标 → 知识讲解(分小节, 含例子) → 小结。内容只依据教材片段。",
  练习: "撰写配套练习, 结构: 一、单选题(4题) 二、多选题(2题) 三、判断题(3题) 四、简答题(2题), 全部附参考答案与解析。题目只能考查教材片段中的知识点。",
  要点卡: "撰写记忆要点卡, 用编号列表列出 8-15 条核心要点, 每条一句话, 只依据教材片段。",
  课件: "撰写课件大纲: 每个 `## 小节` 就是一页幻灯片, 每页用 3-6 条要点, 首页为标题页, 末页为小结页。内容只依据教材片段。",
};

export function materialSystemPrompt(mtype: string): string {
  const p = MATERIAL_PROMPTS[mtype as MaterialType] ?? MATERIAL_PROMPTS["讲义"];
  return `你是警务院校课程辅导材料撰写助手。${p} 用 Markdown 输出。`;
}

export function materialUserPrompt(
  course: string,
  chapter: string,
  mtype: string,
  slices: ChunkRef[],
): string {
  const part = slices
    .slice(0, 8)
    .map((s) => `【${s.doc_name}·${s.chapter}】${s.content.slice(0, 400)}`)
    .join("\n---\n");
  return `课程：${course}；章节：${chapter}；材料类型：${mtype}。\n教材片段：\n${part}`;
}

export function fallbackMaterialBody(
  course: string,
  chapter: string,
  mtype: string,
  slices: ChunkRef[],
): string {
  const title = `${chapter}·${mtype}（模板降级）`;
  const points = slices.slice(0, 8).map((s, i) => `${i + 1}. ${s.content.slice(0, 80)}…（${s.doc_name}·${s.chapter}）`);
  return [
    `# ${title}`,
    "",
    `> 本${mtype}由模板骨架生成（AI 暂不可用）, 内容为「${course}·${chapter}」教材要点摘录, 请教师补充完善。`,
    "",
    "## 教材要点摘录",
    "",
    ...(points.length ? points : ["（无教材切片）"]),
  ].join("\n");
}

// ── 溯源章节 ─────────────────────────────────────────────────────

export interface PlanSource {
  chunk_id: string;
  doc_name: string;
  chapter: string;
}

/** 导出前置: 把 sources 追加为「教材溯源」章节 (承袭源项目 _with_sources) */
export function withSourcesSection(md: string, sources: PlanSource[]): string {
  if (!sources.length) return md;
  const lines = [
    md.trimEnd(),
    "",
    "---",
    "",
    "## 教材溯源（生成依据）",
    "",
    ...sources.map((s, i) => `${i + 1}. ${s.doc_name} · ${s.chapter}（切片 ${s.chunk_id.slice(0, 8)}）`),
  ];
  return lines.join("\n");
}

// ── Markdown → doc-worker 块模型 ────────────────────────────────

/**
 * 教案 Markdown → @action/doc-worker 的 DocBlock[] (确定性转换, 不做内容创作)。
 * 支持: #/##/### 标题、无序/有序列表、表格、普通段落 (**粗体**标记剥除为纯文本)。
 * 代码围栏/引用行/分隔线/图片按行忽略或降级为段落文本。
 */
export function mdToBlocks(md: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", text: inlineStrip(para.join(" ")) });
      para = [];
    }
  };
  const inlineStrip = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { flushPara(); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); i++; continue; }
    if (/^```/.test(t)) { // 代码围栏: 跳到围栏结束, 内容并入段落文本
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      if (buf.length) blocks.push({ type: "paragraph", text: buf.join(" ").trim() });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", text: inlineStrip(h[2]), level });
      i++; continue;
    }
    // 表格: 当前行含 | 且下一行是分隔行
    if (t.includes("|") && /^\|?[\s:|-]+\|[\s:|-]*$/.test((lines[i + 1] ?? "").trim()) && (lines[i + 1] ?? "").includes("-")) {
      flushPara();
      const parseRow = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inlineStrip(c));
      const header = parseRow(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      if (header.length) blocks.push({ type: "table", header, rows });
      continue;
    }
    // 列表 (连续同类行聚合; 无序/有序切换时另起一块)
    if (/^[-*+]\s+/.test(t) || /^\d+[.、)]\s*/.test(t)) {
      flushPara();
      const ordered = /^\d+[.、)]/.test(t);
      const items: string[] = [];
      let n = 1;
      while (i < lines.length) {
        const lt = lines[i].trim();
        const m2 = ordered
          ? /^\d+[.、)]\s+(.*)$/.exec(lt)
          : /^[-*+]\s+(.*)$/.exec(lt);
        if (!m2) break;
        items.push((ordered ? `${n++}. ` : "") + inlineStrip(m2[1]));
        i++;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }
    // 引用行: 去掉 > 独立成段 (不并入上文段落)
    if (/^>\s?/.test(t)) {
      flushPara();
      blocks.push({ type: "paragraph", text: inlineStrip(t.replace(/^>\s?/, "")) });
      i++;
      continue;
    }
    para.push(t);
    i++;
  }
  flushPara();
  return blocks;
}
