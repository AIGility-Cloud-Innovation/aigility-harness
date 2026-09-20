/**
 * L5 行动执行层: 文档工人 (doc-worker)
 *
 * D5 文档工人：领活（结构化文档 JSON）→ 执行（服务端 docx 渲染）→ 交产出
 * （base64 + 落盘路径）→ 受验收（调用方/前端人工确认）。
 *
 * 与编码代理工人（codex/zcode/claude）同属行动域"产出真实工件"的工人；
 * 区别于 LLM 直接生成文本：本工人把**已确认**的结构化内容确定性渲染为
 * .docx 文件，不做任何内容创作 —— 内容生成是 D2 认知域的事。
 *
 * 契约采用通用块模型（heading/paragraph/bullets/table），调用方（如
 * examples/fde-workbench 的方案三件套）负责把业务对象映射为块序列。
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
  /** docx 文件内容（base64），调用方可直接构造 Blob 下载 */
  base64: string;
  /** 服务端落盘路径（留存审计用） */
  savedTo: string;
}

export const docWorkerService: ServiceDefinition<DocWorkerRequest, DocWorkerResponse> = {
  id: "@action/doc-worker",
  version: "1.0.0",
  layer: LayerId.Action,
  description: "文档工人：结构化块 JSON → 服务端确定性渲染 .docx（base64 + 落盘），内容创作归 D2 认知域",
};

// ── Provider 实现 ────────────────────────────────────────────────

const HEADING_LEVEL = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const PRIMARY = "3370FF";
const DARK = "1F2937";
const GRAY = "6B7280";

const sanitizeBasename = (s: string) =>
  (s || "document").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "document";

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
        children: [new TextRun({ text: block.text, size: 22, bold: block.bold ?? false, color: block.bold ? DARK : "374151" })],
      })];
    case "bullets":
      return block.items.map(item => new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: `· ${item}`, size: 22, color: "374151" })],
      }));
    case "table": {
      const cell = (text: string, opts?: { bold?: boolean; fill?: string }) => new TableCell({
        shading: opts?.fill ? { fill: opts.fill } : undefined,
        children: [new Paragraph({
          children: [new TextRun({ text, size: 20, bold: opts?.bold ?? false, color: opts?.bold ? "FFFFFF" : "374151" })],
        })],
      });
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: block.header.map(h => cell(h, { bold: true, fill: PRIMARY })) }),
          ...block.rows.map(r => new TableRow({ children: r.map(c => cell(c)) })),
        ],
      }), new Paragraph({ spacing: { after: 200 }, children: [] })];
    }
  }
}

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

    const buffer = await Packer.toBuffer(doc);
    const filename = `${sanitizeBasename(request.basename || request.title)}.docx`;
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
    });
  },
  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      detail: "doc-worker ready",
      checkedAt: new Date().toISOString(),
    };
  },
};

// ── 插件清单 ─────────────────────────────────────────────────────

export const manifest: PluginManifest = {
  name: "@action/doc-worker",
  layer: LayerId.Action,
  description: "行动执行层：文档工人（结构化块 → 服务端 docx 渲染）",
  version: "1.0.0",
  provides: [docWorkerService],
  consumes: [],
  preferredCarrier: CarrierKind.Thread,
};
