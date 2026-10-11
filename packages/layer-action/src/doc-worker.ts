/**
 * L5 行动执行层: 文档工人 (doc-worker)
 *
 * D5 文档工人：领活（结构化文档 JSON）→ 执行（服务端确定性渲染）→ 交产出
 * （base64 + 落盘路径）→ 受验收（调用方/前端人工确认）。
 *
 * 与编码代理工人（codex/zcode/claude/pi）同属行动域"产出真实工件"的工人；
 * 区别于 LLM 直接生成文本：本工人把**已确认**的结构化内容确定性渲染为文件，
 * 不做任何内容创作 —— 内容生成是 D2 认知域的事。
 *
 * 四格式（harness #3，2026-10-07）：同一块模型渲染 docx / pdf / xlsx / html，
 * 库选型（issue 要求"尽量找现成的"）：
 *   - docx: docx（既有）
 *   - pdf:  pdfkit——内置 fontkit 原生支持系统 Noto CJK 的 .ttc 集合
 *           （`doc.font(ttc路径, postscript名)`），中文实测可渲染可抽取；
 *           字体路径/实名可用 PDF_CJK_FONT_* 环境变量覆盖（私有化部署适配）。
 *   - xlsx: exceljs
 *   - html: 零依赖内联 CSS 模板（同时是前端预览最友好的形态）
 *
 * 契约采用通用块模型（heading/paragraph/bullets/table），调用方负责把业务
 * 对象映射为块序列。响应带 format/mime，前端可按 MIME 直接构造预览 Blob。
 */

import {
  LayerId,
  CarrierKind,
  PluginState,
  err,
  ok,
} from "@aigility-harness/core";
import type {
  ServiceDefinition,
  Provider,
  SeamContext,
  LayerPlugin,
  PluginManifest,
  Result,
  HealthStatus,
} from "@aigility-harness/core";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ── 块模型 ───────────────────────────────────────────────────────

export type DocBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string; bold?: boolean }
  | { type: "bullets"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] };

export type DocFormat = "docx" | "pdf" | "xlsx" | "html";

const FORMAT_EXT: Record<DocFormat, string> = {
  docx: ".docx",
  pdf: ".pdf",
  xlsx: ".xlsx",
  html: ".html",
};

const FORMAT_MIME: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html; charset=utf-8",
};

// ── 请求/响应 ────────────────────────────────────────────────────

export interface DocWorkerRequest {
  /** 文档标题（同时作为缺省文件名来源） */
  title: string;
  /** 标题下方的元信息行（客户/版本/日期等） */
  subtitle?: string;
  /** 文档作者（docx 元数据 creator） */
  creator?: string;
  /** 文档正文块序列 */
  blocks: DocBlock[];
  /** 输出格式（缺省 docx，向后兼容既有调用方） */
  format?: DocFormat;
  /** 输出文件名（不含扩展名；非法字符自动清洗；缺省取 title） */
  basename?: string;
  /** 落盘目录覆盖（缺省 DOC_WORKER_DIR 环境变量，再缺省系统临时目录/aigility-doc-worker） */
  outputDir?: string;
}

export interface DocWorkerResponse {
  ok: boolean;
  /** 清洗后的实际文件名（含扩展名） */
  filename: string;
  /** 文件字节数 */
  bytes: number;
  /** 文件内容（base64），调用方可直接构造 Blob 下载或预览 */
  base64: string;
  /** 服务端落盘路径（留存审计用） */
  savedTo: string;
  /** 本次产出的格式与 MIME（前端按 MIME 构造预览 Blob） */
  format: DocFormat;
  mime: string;
}

export const docWorkerService: ServiceDefinition<DocWorkerRequest, DocWorkerResponse> = {
  id: "@action/doc-worker",
  version: "1.1.0",
  layer: LayerId.Action,
  description:
    "文档工人：结构化块 JSON → 服务端确定性渲染 docx/pdf/xlsx/html（base64 + 落盘），内容创作归 D2 认知域",
};

// ── 公共版式常量 ─────────────────────────────────────────────────

const HEADING_LEVEL = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const PRIMARY = "3370FF";
const DARK = "1F2937";
const GRAY = "6B7280";
const BODY = "374151";

const sanitizeBasename = (s: string) =>
  (s || "document").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "document";

/** 单元格取值兜底（表格行可能传 null/undefined） */
const cellText = (v: unknown): string => String(v ?? "");

// ── docx 渲染（既有逻辑原样保留） ────────────────────────────────

function blockToParagraphs(block: DocBlock): Array<Paragraph | Table> {
  switch (block.type) {
    case "heading":
      return [new Paragraph({
        heading: HEADING_LEVEL[block.level ?? 2],
        spacing: { before: 360, after: 160 },
        children: [new TextRun({ text: block.text, bold: true, size: 28, color: PRIMARY })],
      })];
    case "paragraph":
      return [new Paragraph({
        spacing: { after: 200, line: 360 },
        children: [new TextRun({ text: block.text, size: 22, bold: block.bold ?? false, color: block.bold ? DARK : BODY })],
      })];
    case "bullets":
      return block.items.map(item => new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `· ${item}`, size: 22, color: BODY })],
      }));
    case "table": {
      const cell = (text: string, opts?: { bold?: boolean; fill?: string }) => new TableCell({
        shading: opts?.fill ? { fill: opts.fill } : undefined,
        children: [new Paragraph({
          children: [new TextRun({ text, size: 20, bold: opts?.bold ?? false, color: opts?.bold ? "FFFFFF" : BODY })],
        })],
      });
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: block.header.map(h => cell(cellText(h), { bold: true, fill: PRIMARY })) }),
          ...block.rows.map(r => new TableRow({ children: r.map(c => cell(cellText(c))) })),
        ],
      }), new Paragraph({ spacing: { after: 200 }, children: [] })];
    }
  }
}

async function renderDocx(request: DocWorkerRequest): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: request.title, bold: true, size: 44, color: DARK })],
    }),
  ];
  if (request.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: request.subtitle, size: 20, color: GRAY })],
    }));
  }
  for (const block of request.blocks) children.push(...blockToParagraphs(block));

  const doc = new Document({
    creator: request.creator ?? "aigility-harness doc-worker",
    title: request.title,
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// ── pdf 渲染（pdfkit + 系统 Noto CJK TTC） ───────────────────────

// 私有化部署可经环境变量替换字体（路径 + TTC 内的 postscript 实名）
const PDF_FONT_REGULAR = process.env.PDF_CJK_FONT_REGULAR ?? "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const PDF_FONT_REGULAR_NAME = process.env.PDF_CJK_FONT_REGULAR_NAME ?? "NotoSansCJKsc-Regular";
const PDF_FONT_BOLD = process.env.PDF_CJK_FONT_BOLD ?? "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc";
const PDF_FONT_BOLD_NAME = process.env.PDF_CJK_FONT_BOLD_NAME ?? "NotoSansCJKsc-Bold";

const PDF_HEX = (hex: string) => `#${hex}`;

/** pdfkit 是 Node 流：监听 data/end 收集成 Buffer */
function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
    doc.on("error", (e: Error) => rejectPromise(e));
    doc.end();
  });
}

function renderPdf(request: DocWorkerRequest): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 56, pdfVersion: "1.7", autoFirstPage: true });
  const pageW = doc.page.width;
  const usableW = pageW - 56 * 2;
  const pageBottom = doc.page.height - 56;

  // 标题（粗体居中）与副标题（灰色居中）
  doc.font(PDF_FONT_BOLD, PDF_FONT_BOLD_NAME);
  const titleSize = 20;
  const titleW = doc.widthOfString(request.title, { fontSize: titleSize } as never);
  doc.fontSize(titleSize).fillColor(PDF_HEX(DARK))
    .text(request.title, 56 + Math.max(0, (usableW - titleW) / 2), 68, { width: usableW, align: "center" });
  if (request.subtitle) {
    doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
    doc.fontSize(9.5).fillColor(PDF_HEX(GRAY)).text(request.subtitle, 56, doc.y + 6, { width: usableW, align: "center" });
  }
  doc.moveDown(1.2);

  const ensureSpace = (need: number): void => {
    if (doc.y + need > pageBottom) doc.addPage();
  };

  for (const block of request.blocks) {
    switch (block.type) {
      case "heading": {
        doc.font(PDF_FONT_BOLD, PDF_FONT_BOLD_NAME);
        ensureSpace(40);
        doc.fontSize(block.level === 1 ? 15 : block.level === 3 ? 11.5 : 13)
          .fillColor(PDF_HEX(PRIMARY))
          .text(block.text, 56, doc.y + 10, { width: usableW });
        doc.moveDown(0.4);
        break;
      }
      case "paragraph": {
        doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
        doc.fontSize(10.5).fillColor(PDF_HEX(block.bold ? DARK : BODY));
        ensureSpace(30);
        doc.text(block.text, 56, doc.y + 4, { width: usableW, lineGap: 3 });
        doc.moveDown(0.5);
        break;
      }
      case "bullets": {
        doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
        doc.fontSize(10.5).fillColor(PDF_HEX(BODY));
        for (const item of block.items) {
          ensureSpace(24);
          doc.text(`• ${item}`, 64, doc.y + 2, { width: usableW - 8, lineGap: 2 });
        }
        doc.moveDown(0.5);
        break;
      }
      case "table": {
        const cols = Math.max(1, block.header.length);
        const colW = usableW / cols;
        const pad = 5;
        doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
        const rowHeight = (cells: string[], fontSize: number, boldFont: boolean): number => {
          if (boldFont) doc.font(PDF_FONT_BOLD, PDF_FONT_BOLD_NAME);
          else doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
          let maxLines = 1;
          for (const c of cells) {
            const h = doc.heightOfString(cellText(c), { width: colW - pad * 2, fontSize } as never);
            maxLines = Math.max(maxLines, Math.ceil(h / (fontSize + 2)));
          }
          return maxLines * (fontSize + 3) + pad * 2;
        };

        const drawRow = (cells: string[], y: number, height: number, header: boolean): void => {
          if (header) {
            doc.font(PDF_FONT_BOLD, PDF_FONT_BOLD_NAME);
            doc.rect(56, y, usableW, height).fill(PDF_HEX(PRIMARY));
          }
          cells.forEach((c, i) => {
            const x = 56 + i * colW;
            doc.font(header ? PDF_FONT_BOLD : PDF_FONT_REGULAR, header ? PDF_FONT_BOLD_NAME : PDF_FONT_REGULAR_NAME);
            doc.fillColor(PDF_HEX(header ? "FFFFFF" : BODY))
              .fontSize(9)
              .text(cellText(c), x + pad, y + pad, { width: colW - pad * 2, height: height - pad, ellipsis: true, lineBreak: true });
          });
          if (!header) {
            doc.moveTo(56, y + height).lineTo(56 + usableW, y + height)
              .lineWidth(0.5).strokeColor("#E5E7EB").stroke();
          }
        };

        let y = doc.y + 6;
        const headH = rowHeight(block.header.map(cellText), 9, true);
        ensureSpace(headH + 20);
        if (doc.y + headH > pageBottom) { doc.addPage(); y = doc.y + 6; }
        drawRow(block.header.map(cellText), y, headH, true);
        y += headH;
        for (const r of block.rows) {
          const cells = r.map(cellText);
          const h = rowHeight(cells, 9, false);
          if (y + h > pageBottom) {
            doc.addPage();
            const hh = rowHeight(block.header.map(cellText), 9, true);
            drawRow(block.header.map(cellText), 56 + 0, hh, true);
            y = 56 + hh;
          }
          drawRow(cells, y, h, false);
          y += h;
        }
        doc.font(PDF_FONT_REGULAR, PDF_FONT_REGULAR_NAME);
        doc.y = y + 10;
        doc.x = 56;
        break;
      }
    }
  }

  return pdfToBuffer(doc);
}

// ── xlsx 渲染（exceljs） ─────────────────────────────────────────

async function renderXlsx(request: DocWorkerRequest): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = request.creator ?? "aigility-harness doc-worker";
  const ws = wb.addWorksheet(request.title.slice(0, 31) || "Sheet1");

  // 粗略列宽：按全表内容（CJK 记 2）取最大，夹在 [10, 50]
  const widthOf = (s: string) =>
    Math.min(50, Math.max(10, [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2));
  let widths: number[] = [];
  for (const b of request.blocks) if (b.type === "table") {
    widths = b.header.map((h, i) => Math.max(widths[i] ?? 0, widthOf(cellText(h))));
    b.rows.forEach(r => r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, widthOf(cellText(c))); }));
  }
  ws.columns = widths.map(w => ({ width: w }));

  let row = 1;
  // 合并列数 = 全文档最大表宽（无表格时 1）。A 列单行内容横跨合并，
  // 人读美观（标题/副标题居中、章节/正文/条目不再挤在 A 列一条竖线里）。
  const mergeCols = Math.max(1, ...request.blocks.map((b) => (b.type === "table" ? b.header.length : 1)));
  /** 写一行并按 mergeCols 横向合并（mergeCols=1 时不合并） */
  const setCell = (text: string, font: Partial<ExcelJS.Font>, opts?: { wrap?: boolean; center?: boolean }): void => {
    const r = ws.getRow(row);
    const c = r.getCell(1);
    c.value = text;
    c.font = font;
    if (opts?.wrap) c.alignment = { wrapText: true, vertical: "top" };
    else if (opts?.center) c.alignment = { horizontal: "center", vertical: "middle" };
    if (mergeCols > 1) ws.mergeCells(row, 1, row, mergeCols);
    r.commit();
    row += 1;
  };

  setCell(request.title, { bold: true, size: 14, color: { argb: `FF${DARK}` } }, { center: true });
  if (request.subtitle) setCell(request.subtitle, { size: 10, color: { argb: `FF${GRAY}` } }, { center: true });
  row += 1;

  for (const block of request.blocks) {
    switch (block.type) {
      case "heading": {
        setCell(block.text, { bold: true, size: 12, color: { argb: `FF${PRIMARY}` } });
        break;
      }
      case "paragraph": {
        setCell(block.text, { size: 10.5, bold: block.bold ?? false, color: { argb: `FF${block.bold ? DARK : BODY}` } }, { wrap: true });
        break;
      }
      case "bullets": {
        for (const item of block.items) {
          setCell(`· ${item}`, { size: 10.5, color: { argb: `FF${BODY}` } });
        }
        break;
      }
      case "table": {
        const head = ws.getRow(row);
        block.header.forEach((h, i) => {
          const c = head.getCell(i + 1);
          c.value = cellText(h);
          c.font = { bold: true, color: { argb: "FFFFFFFF" } };
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${PRIMARY}` } };
          c.alignment = { vertical: "middle" };
        });
        head.commit();
        row += 1;
        for (const r0 of block.rows) {
          const rr = ws.getRow(row);
          r0.forEach((c0, i) => {
            const c = rr.getCell(i + 1);
            c.value = cellText(c0);
            c.font = { size: 10.5, color: { argb: `FF${BODY}` } };
            c.alignment = { wrapText: true, vertical: "top" };
          });
          rr.commit();
          row += 1;
        }
        row += 1;
        break;
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

// ── html 渲染（零依赖内联 CSS，兼作前端预览最优形态） ─────────────

const htmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderHtml(request: DocWorkerRequest): string {
  const body = request.blocks.map(b => {
    switch (b.type) {
      case "heading": {
        const level = Math.min(4, Math.max(2, (b.level ?? 2) + 1));
        return `<h${level} class="hd">${htmlEscape(b.text)}</h${level}>`;
      }
      case "paragraph":
        return `<p class="${b.bold ? "strong" : ""}">${htmlEscape(b.text)}</p>`;
      case "bullets":
        return `<ul>${b.items.map(i => `<li>${htmlEscape(i)}</li>`).join("")}</ul>`;
      case "table":
        return `<table><thead><tr>${b.header.map(h => `<th>${htmlEscape(cellText(h))}</th>`).join("")}</tr></thead><tbody>${
          b.rows.map(r => `<tr>${r.map(c => `<td>${htmlEscape(cellText(c))}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`;
    }
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${htmlEscape(request.title)}</title>
<style>
  body { font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         color: #${BODY}; max-width: 800px; margin: 24px auto; padding: 0 16px; line-height: 1.7; }
  h1.title { color: #${DARK}; text-align: center; font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #${GRAY}; text-align: center; font-size: 12px; margin-bottom: 28px; }
  .hd { color: #${PRIMARY}; margin-top: 26px; }
  p.strong { color: #${DARK}; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 13px; }
  th { background: #${PRIMARY}; color: #fff; font-weight: 600; text-align: left; }
  th, td { padding: 7px 10px; border-bottom: 1px solid #E5E7EB; vertical-align: top; }
  li { margin: 3px 0; }
</style>
</head>
<body>
<h1 class="title">${htmlEscape(request.title)}</h1>
${request.subtitle ? `<div class="subtitle">${htmlEscape(request.subtitle)}</div>` : ""}
${body}
</body>
</html>`;
}

// ── Provider 实现 ────────────────────────────────────────────────

export const docWorkerProvider: Provider<DocWorkerRequest, DocWorkerResponse> = {
  service: docWorkerService,
  name: "action-doc-worker-docx",
  state: PluginState.Active,
  async execute(
    request: DocWorkerRequest,
    _ctx: SeamContext,
  ): Promise<Result<DocWorkerResponse>> {
    if (!request.title?.trim()) return err("doc-worker: title 必填");
    if (!Array.isArray(request.blocks) || request.blocks.length === 0) {
      return err("doc-worker: blocks 不能为空");
    }
    const format: DocFormat = request.format ?? "docx";
    if (!(format in FORMAT_EXT)) {
      return err(`doc-worker: 不支持的 format=${String(format)}（可选 docx/pdf/xlsx/html）`);
    }

    let buffer: Buffer;
    try {
      if (format === "docx") buffer = await renderDocx(request);
      else if (format === "pdf") buffer = await renderPdf(request);
      else if (format === "xlsx") buffer = await renderXlsx(request);
      else buffer = Buffer.from(renderHtml(request), "utf8");
    } catch (e) {
      return err(`doc-worker: ${format} 渲染失败：${e instanceof Error ? e.message : String(e)}`);
    }

    const filename = `${sanitizeBasename(request.basename || request.title)}${FORMAT_EXT[format]}`;
    const outputDir = resolve(request.outputDir || process.env.DOC_WORKER_DIR || join(tmpdir(), "aigility-doc-worker"));
    mkdirSync(outputDir, { recursive: true });
    const savedTo = join(outputDir, `${randomUUID().slice(0, 8)}-${filename}`);
    writeFileSync(savedTo, buffer);

    return ok({
      ok: true,
      filename,
      bytes: buffer.byteLength,
      base64: buffer.toString("base64"),
      savedTo,
      format,
      mime: FORMAT_MIME[format],
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "doc-worker ready (docx/pdf/xlsx/html)",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/doc-worker",
  layer: LayerId.Action,
  description: "行动执行层：文档工人（结构化块 → 服务端 docx/pdf/xlsx/html 渲染）",
  version: "1.1.0",
  provides: [docWorkerService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};

let pluginState: PluginState = PluginState.Registered;

export const plugin: LayerPlugin = {
  manifest,
  async onLoad(_ctx: SeamContext): Promise<Result<void>> {
    pluginState = PluginState.Active;
    return ok(undefined);
  },
  async onUnload(): Promise<Result<void>> {
    pluginState = PluginState.Registered;
    return ok(undefined);
  },
  getProviders(): Provider[] {
    return [docWorkerProvider];
  },
  getState(): PluginState {
    return pluginState;
  },
};
