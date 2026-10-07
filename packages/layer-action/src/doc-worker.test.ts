import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docWorkerService, docWorkerProvider } from "./doc-worker.js";
import type { SeamContext } from "@aigility-harness/core";

const OUT_DIR = mkdtempSync(join(tmpdir(), "doc-worker-test-"));
const ctx = {
  sessionId: "s",
  traceId: "t",
} as unknown as SeamContext;

afterAll(() => {
  // 测试产物留在系统临时目录, 由 OS 清理
});

describe("@action/doc-worker 契约", () => {
  it("服务定义归属 Action 层", () => {
    expect(docWorkerService.id).toBe("@action/doc-worker");
    expect(docWorkerService.layer).toBe("action");
  });

  it("结构化块渲染为合法 docx (PK zip 头) 并落盘", async () => {
    const result = await docWorkerProvider.execute(
      {
        title: "宁夏电信智能赋能解决方案",
        subtitle: "客户：宁夏电信 · 太忆 TiMEM · v1 · 09-18",
        creator: "测试",
        basename: "方案_v1",
        blocks: [
          { type: "heading", text: "一、客户背景", level: 2 },
          { type: "paragraph", text: "客户希望数据不出内网。" },
          { type: "bullets", items: ["私有化部署", "运维托管"] },
          { type: "table", header: ["费用项", "金额"], rows: [["基础一体机", "200000"]] },
        ],
        outputDir: OUT_DIR,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const value = (result as { value?: { filename?: string; bytes?: number; base64?: string; savedTo?: string } }).value!;
    expect(value.filename).toBe("方案_v1.docx");
    expect(value.bytes).toBeGreaterThan(0);
    // docx 本质是 zip, 首两字节为 'PK'
    const head = Buffer.from(value.base64!, "base64").subarray(0, 2).toString();
    expect(head).toBe("PK");
    expect(existsSync(value.savedTo!)).toBe(true);
    expect(readdirSync(OUT_DIR).length).toBe(1);
  });

  it("参数缺失时返回 err 而非抛异常", async () => {
    const noTitle = await docWorkerProvider.execute({ title: "", blocks: [{ type: "paragraph", text: "x" }], outputDir: OUT_DIR }, ctx);
    expect(noTitle.ok).toBe(false);
    const noBlocks = await docWorkerProvider.execute({ title: "t", blocks: [], outputDir: OUT_DIR }, ctx);
    expect(noBlocks.ok).toBe(false);
  });

  // ── 四格式（harness #3，2026-10-07）：同一块模型渲染 docx/pdf/xlsx/html ──

  const SAMPLE = {
    title: "智能赋能方案（四格式回归）",
    subtitle: "客户：测试 · 2026-10-07",
    blocks: [
      { type: "heading" as const, text: "一、背景", level: 2 },
      { type: "paragraph" as const, text: "数据不出内网，中文渲染必须正确。" },
      { type: "bullets" as const, items: ["私有化部署", "运维托管"] },
      { type: "table" as const, header: ["费用项", "金额"], rows: [["基础一体机", "200000"]] },
    ],
  };

  it("pdf：系统 Noto CJK 渲染中文（%PDF 头 + pdftotext 可抽取由手工验证）", async () => {
    const r = await docWorkerProvider.execute({ ...SAMPLE, format: "pdf", outputDir: OUT_DIR }, ctx);
    expect(r.ok).toBe(true);
    const v = (r as { value?: { filename?: string; base64?: string; mime?: string; format?: string } }).value!;
    expect(v.filename).toBe("智能赋能方案（四格式回归）.pdf");
    const head = Buffer.from(v.base64!, "base64").subarray(0, 5).toString();
    expect(head).toBe("%PDF-");
    expect(v.mime).toBe("application/pdf");
    expect(v.format).toBe("pdf");
  });

  it("xlsx：exceljs 产物（PK zip 头）", async () => {
    const r = await docWorkerProvider.execute({ ...SAMPLE, format: "xlsx", outputDir: OUT_DIR }, ctx);
    expect(r.ok).toBe(true);
    const v = (r as { value?: { base64?: string; mime?: string } }).value!;
    const head = Buffer.from(v.base64!, "base64").subarray(0, 2).toString();
    expect(head).toBe("PK");
    expect(v.mime).toContain("spreadsheetml");
  });

  it("html：零依赖内联 CSS，含标题与表格转义", async () => {
    const r = await docWorkerProvider.execute(
      { ...SAMPLE, format: "html", basename: "回归<html>", outputDir: OUT_DIR },
      ctx,
    );
    expect(r.ok).toBe(true);
    const v = (r as { value?: { base64?: string; mime?: string; filename?: string } }).value!;
    const html = Buffer.from(v.base64!, "base64").toString("utf8");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("中文渲染必须正确");
    expect(html).toContain("<th>费用项</th>");
    expect(v.mime).toContain("text/html");
    expect(v.filename).toBe("回归_html_.html");
  });

  it("非法 format → err 列出可选值", async () => {
    const r = await docWorkerProvider.execute(
      // 故意传非法值验证守卫
      { ...SAMPLE, format: "doc" as never, outputDir: OUT_DIR },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("docx/pdf/xlsx/html");
  });
});
