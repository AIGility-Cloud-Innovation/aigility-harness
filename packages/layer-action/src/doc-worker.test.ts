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
});
