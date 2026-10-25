/**
 * task-release-gate 单测：五要素检查单（结构性 两项 / LLM 三项）、
 * 三种放行动作（auto-release / tag-missing / pending-review）、
 * approve 原语（复核记录/幂等/CAS）、YAML 加载回退。LLM 走假桩。
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_RELEASE_YAML,
  loadReleaseDoc,
  evaluateReleaseGate,
  runReleaseGate,
} from "./task-release-gate.js";
import { TaskRegistry } from "./task-registry.js";
import type { ReleaseLlm, ReleaseDoc } from "./task-release-gate.js";
import type { TaskRecord } from "@aigility-harness/core";

const doc: ReleaseDoc = loadReleaseDoc().doc;

function llmReply(json: string): ReleaseLlm {
  return () => Promise.resolve({ ok: true, value: { text: json } });
}
const allOk = llmReply('{"Why":"ok","What":"ok","How":"ok","How much":"ok","缺什么":""}');

function baseRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    uid: "tsk_test-1",
    title: "优化账单导出",
    description: "Why：导出表格列错位影响对账。What：修复导出列位。How：修复模板渲染并补对账用例。How much：导出与账单一致、对账通过，不改导出权限。执行者：徐彬程",
    status: "planned",
    origin: { provider: "feishu-task", guid: "f-1" },
    projectRef: "TiMEM-AI/timem-platform-backend",
    links: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("结构性检查（不烧 LLM）", () => {
  it("缺项目 → tag-missing +【待确认仓库】，LLM 不被调用", async () => {
    let llmCalls = 0;
    const spy: ReleaseLlm = (req) => {
      llmCalls += 1;
      return allOk(req);
    };
    const d = await evaluateReleaseGate(baseRecord({ projectRef: undefined }), doc, spy);
    expect(d.action).toBe("tag-missing");
    expect(d.missing).toEqual(["项目"]);
    expect(d.tags).toContain("【待确认仓库】");
    expect(llmCalls).toBe(0);
  });

  it("缺执行人 → tag-missing +【待安排执行者】", async () => {
    const d = await evaluateReleaseGate(baseRecord({ description: "Why/What/How/How much 都写了，但没写执行者" }), doc, allOk);
    expect(d.action).toBe("tag-missing");
    expect(d.tags).toContain("【待安排执行者】");
  });
});

describe("LLM 2W2H 判定", () => {
  it("全部要素齐 → auto-release", async () => {
    const d = await evaluateReleaseGate(baseRecord(), doc, allOk);
    expect(d.action).toBe("auto-release");
    expect(d.missing).toEqual([]);
  });

  it("缺How（选填）→ 照常自动放行，只给软提示", async () => {
    const d = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"ok","What":"ok","How":"missing","How much":"ok","缺什么":"没有方案"}'),
    );
    expect(d.action).toBe("auto-release");
    expect(d.missing).toEqual([]);
    expect(d.soft[0]).toContain("How");
    expect(d.tags).toEqual([]);
  });

  it("缺Why（必填）→ 仍拦下 +【缺Why】", async () => {
    const d = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"missing","What":"ok","How":"ok","How much":"ok","缺什么":"没说背景"}'),
    );
    expect(d.action).toBe("tag-missing");
    expect(d.tags).toContain("【缺Why】");
  });
  it("缺How much（必填，验收/边界）→ 拦下 +【缺How much】", async () => {
    const d = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"ok","What":"ok","How":"ok","How much":"missing","缺什么":"没有验收标准"}'),
    );
    expect(d.action).toBe("tag-missing");
    expect(d.tags).toContain("【缺How much】");
  });

  it("选填要素 unsure 不阻塞；必填 unsure 仍转人工", async () => {
    const dOptional = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"ok","What":"ok","How":"unsure","How much":"ok","缺什么":""}'),
    );
    expect(dOptional.action).toBe("auto-release");
    const dRequired = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"unsure","What":"ok","How":"ok","How much":"ok","缺什么":""}'),
    );
    expect(dRequired.action).toBe("pending-review");
  });

  it("workflows/task-release.yaml 数据面文件与内置语义一致（How 选填）", async () => {
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../examples/feishu-task-loop/workflows/task-release.yaml",
    );
    const fileDoc = loadReleaseDoc(file).doc;
    const optional = (fileDoc.nodes["llm_elements"].config?.["optional"] as string[]) ?? [];
    expect(optional).toContain("How");
    const d = await evaluateReleaseGate(
      baseRecord(),
      fileDoc,
      llmReply('{"Why":"ok","What":"ok","How":"missing","How much":"ok","缺什么":""}'),
    );
    expect(d.action).toBe("auto-release");
  });

  it("LLM 判 unsure → pending-review +【待复核】", async () => {
    const d = await evaluateReleaseGate(
      baseRecord(),
      doc,
      llmReply('{"Why":"unsure","What":"ok","How":"ok","How much":"ok","缺什么":"背景太含糊"}'),
    );
    expect(d.action).toBe("pending-review");
    expect(d.tags).toContain("【待复核】");
  });

  it("LLM 输出坏 JSON / 调用失败 → 按 pending-review 兜底", async () => {
    const bad: ReleaseLlm = () => Promise.resolve({ ok: true, value: { text: "我觉得可以" } });
    expect((await evaluateReleaseGate(baseRecord(), doc, bad)).action).toBe("pending-review");
    const down: ReleaseLlm = () => Promise.resolve({ ok: false, error: "llm down" });
    expect((await evaluateReleaseGate(baseRecord(), doc, down)).action).toBe("pending-review");
  });

  it("llm_elements 禁用 = 只查结构要素，直接放行", async () => {
    const docNoLlm: ReleaseDoc = JSON.parse(JSON.stringify(doc));
    docNoLlm.nodes["llm_elements"].enabled = false;
    const d = await evaluateReleaseGate(baseRecord(), docNoLlm, allOk);
    expect(d.action).toBe("auto-release");
  });
});

describe("runReleaseGate 判定+落库", () => {
  it("auto-release 落库：ready + review.via=auto by=system", async () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({
      title: "优化账单导出",
      description: baseRecord().description,
      origin: { provider: "feishu-task", guid: "f-9" },
      projectRef: "TiMEM-AI/timem-platform-backend",
    });
    const res = await runReleaseGate(registry, r.uid, doc, allOk);
    expect(res.ok).toBe(true);
    expect(registry.get(r.uid)?.status).toBe("ready");
    expect(registry.get(r.uid)?.review).toMatchObject({ via: "auto", by: "system" });
  });

  it("tag-missing 不落库，状态停在 planned", async () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "没归属", origin: { provider: "feishu-task", guid: "f-10" } });
    const res = await runReleaseGate(registry, r.uid, doc, allOk);
    expect(res.ok).toBe(true);
    expect(registry.get(r.uid)?.status).toBe("planned");
    expect(registry.get(r.uid)?.review).toBeUndefined();
  });
});

describe("approve 原语（人工放行）", () => {
  it("manual approve 记录复核人；ready 态幂等", () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "低置信", origin: { provider: "feishu-task", guid: "f-11" } });
    expect(registry.approve(r.uid, { via: "manual", by: "johnny", note: "人工确认补齐" }).ok).toBe(true);
    const rec = registry.get(r.uid)!;
    expect(rec.status).toBe("ready");
    expect(rec.review).toMatchObject({ via: "manual", by: "johnny", note: "人工确认补齐" });
    expect(registry.approve(r.uid, { via: "manual", by: "别人" }).ok).toBe(true); // 幂等
    expect(registry.get(r.uid)?.review?.by).toBe("johnny"); // 首次复核人不被覆盖
  });

  it("非 planned 态 approve 被拒（CAS）", () => {
    const registry = new TaskRegistry();
    const r = registry.adopt({ title: "x", origin: { provider: "feishu-task", guid: "f-12" } });
    registry.transition(r.uid, "ready");
    registry.transition(r.uid, "dispatched");
    expect(registry.approve(r.uid, { via: "manual", by: "johnny" }).ok).toBe(false);
  });

  it("built-in 检查单可解析且五要素节点齐备；文件缺失回退 builtin", () => {
    expect(doc.nodes["project_check"]).toBeDefined();
    expect(doc.nodes["executor_check"]).toBeDefined();
    expect(doc.nodes["llm_elements"]).toBeDefined();
    const fallback = loadReleaseDoc("/nonexistent/task-release.yaml");
    expect(fallback.source).toBe("builtin");
    expect(() => parseBuiltin()).not.toThrow();
    function parseBuiltin() {
      loadReleaseDoc().doc;
    }
    void BUILTIN_RELEASE_YAML;
  });
});
