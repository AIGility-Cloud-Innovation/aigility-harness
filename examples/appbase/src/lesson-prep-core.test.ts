import { describe, it, expect } from "vitest";
import {
  LP_TEMPLATES,
  templateOf,
  chunkText,
  stripCodeFence,
  planSystemPrompt,
  planUserPrompt,
  fallbackPlanBody,
  assembleWholeBook,
  materialSystemPrompt,
  fallbackMaterialBody,
  withSourcesSection,
  mdToBlocks,
} from "./lesson-prep-core.js";

const SLICES = [
  { doc_name: "治安管理教材", chapter: "第1章", content: "治安管理处罚的种类有警告、罚款、行政拘留。" },
  { doc_name: "治安管理教材", chapter: "第1章", content: "调解原则：自愿、合法、公正。" },
];

describe("lesson-prep-core 四课型模板", () => {
  it("四套课型模板齐备, 未知 key 回落标准教案", () => {
    expect(LP_TEMPLATES.map((t) => t.key)).toEqual(["standard", "practical", "ideology", "review"]);
    expect(templateOf("nope").key).toBe("standard");
    expect(templateOf("practical").sections).toContain("安全注意");
  });

  it("教案 prompt 带模板结构与「只依据教材」约束", () => {
    const sys = planSystemPrompt("standard");
    expect(sys).toContain("只依据教材");
    expect(sys).toContain("思政融入点");
    const user = planUserPrompt("治安管理", "第1章 处罚种类", SLICES);
    expect(user).toContain("治安管理");
    expect(user).toContain("警告、罚款");
  });
});

describe("lesson-prep-core 教材分片与围栏", () => {
  it("chunkText 段落感知分片, 空文本返回空", () => {
    expect(chunkText("")).toEqual([]);
    const long = Array.from({ length: 10 }, (_, i) => `第${i}段。${"内容".repeat(60)}`).join("\n\n");
    const chunks = chunkText(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 260)).toBe(true);
  });

  it("超长段落按句再切, 不丢内容", () => {
    const big = "一句。".repeat(400); // 800 字
    const chunks = chunkText(big, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join("")).toContain("一句。");
  });

  it("stripCodeFence 剥 ```markdown 围栏, 普通文本原样", () => {
    expect(stripCodeFence("```markdown\n# 标题\n正文\n```")).toBe("# 标题\n正文");
    expect(stripCodeFence("# 普通")).toBe("# 普通");
  });
});

describe("lesson-prep-core 降级骨架", () => {
  it("教案降级带模板小节与 degraded 字样", () => {
    const body = fallbackPlanBody("治安管理", "第1章", "ideology", SLICES);
    expect(body).toContain("模板降级");
    for (const sec of templateOf("ideology").sections) expect(body).toContain(sec);
    expect(body).toContain("治安管理教材");
  });

  it("整册拼装含总览与逐章小节, 未完成章带占位", () => {
    const md = assembleWholeBook(
      "治安管理",
      [
        { chapter: "第1章", body: "# 治安管理·第1章教案\n\n## 教学目标\n...", done: true },
        { chapter: "第2章", body: "", done: false },
      ],
      "standard",
    );
    expect(md).toContain("整册教案");
    expect(md).toContain("课程结构总览");
    expect(md).toContain("第1章");
    expect(md).toContain("生成中");
    expect(md).toContain("教学目标");
  });

  it("材料降级带类型与摘录; 材料 prompt 分型", () => {
    const body = fallbackMaterialBody("治安管理", "第1章", "课件", SLICES);
    expect(body).toContain("第1章·课件");
    expect(body).toContain("模板降级");
    expect(materialSystemPrompt("课件")).toContain("幻灯片");
    expect(materialSystemPrompt("练习")).toContain("参考答案");
    expect(materialSystemPrompt("未知类型")).toContain("讲义");
  });
});

describe("lesson-prep-core 溯源与 mdToBlocks", () => {
  it("withSourcesSection 追加溯源章节", () => {
    const out = withSourcesSection("# 教案\n正文", [
      { chunk_id: "abcd1234-xxxx", doc_name: "教材A", chapter: "第1章" },
    ]);
    expect(out).toContain("教材溯源");
    expect(out).toContain("教材A · 第1章");
  });

  it("mdToBlocks 转换标题/列表/表格/段落, 剥行内标记", () => {
    const blocks = mdToBlocks(
      [
        "# 教案题目",
        "## 教学目标",
        "- 掌握处罚种类",
        "1. 第一条要点",
        "2. 第二条要点",
        "| 环节 | 时长 |",
        "| --- | --- |",
        "| 引入 | 5min |",
        "",
        "这是**加粗**的正文段落。",
        "> 引用也算段落",
      ].join("\n"),
    );
    const headings = blocks.filter((b) => b.type === "heading") as Array<{ type: "heading"; text: string; level: number }>;
    expect(headings.map((h) => h.level)).toEqual([1, 2]);
    const bullets = blocks.filter((b) => b.type === "bullets") as Array<{ type: "bullets"; items: string[] }>;
    expect(bullets[0].items).toEqual(["掌握处罚种类"]);
    expect(bullets[1].items).toEqual(["1. 第一条要点", "2. 第二条要点"]);
    const table = blocks.find((b) => b.type === "table") as { type: "table"; header: string[]; rows: string[][] };
    expect(table.header).toEqual(["环节", "时长"]);
    expect(table.rows[0]).toEqual(["引入", "5min"]);
    const paras = blocks.filter((b) => b.type === "paragraph") as Array<{ type: "paragraph"; text: string }>;
    expect(paras.some((p) => p.text === "这是加粗的正文段落。")).toBe(true);
    expect(paras.some((p) => p.text.includes("引用也算段落"))).toBe(true);
  });

  it("mdToBlocks 跳过代码围栏不挂死", () => {
    const blocks = mdToBlocks("# T\n```js\nconst a = 1;\n```\n尾段");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });
});
