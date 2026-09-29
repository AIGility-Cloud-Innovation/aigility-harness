import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeTitle,
  jaccard,
  parseCandidateTasks,
  buildJudgeMessages,
  filterDuplicates,
  shouldFireTick,
  collectMessage,
  clearBuffer,
  lastCollectAnchor,
  parseChatRepoMap,
  groupByChat,
  assignRepoForPool,
  addPendingCandidate,
  peekPendingCandidate,
  takePendingCandidate,
  dropPendingCandidate,
  clearPendingCandidates,
  findPendingCandidateByNo,
  feishuFirstEnabled,
} from "./task-pipeline.js";

describe("normalizeTitle / jaccard", () => {
  it("归一化去标点压空白", () => {
    expect(normalizeTitle("修复：登录页 白屏！")).toBe("修复 登录页 白屏");
  });

  it("完全一致 → 1，无关 → 0", () => {
    expect(jaccard("修复登录白屏", "修复 登录 白屏")).toBe(1);
    expect(jaccard("修复登录白屏", "新增导出功能")).toBe(0);
  });

  it("部分重叠介于 0-1", () => {
    const s = jaccard("修复登录页白屏问题", "登录页 白屏 报错");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("parseCandidateTasks", () => {
  it("解析裸 JSON 数组", () => {
    const out = parseCandidateTasks(
      `[{"title":"修复登录白屏","priority":"P1","repo":"TiMEM-Space","reason":"明确 bug"}]`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe("P1");
    expect(out[0].repo).toBe("TiMEM-Space");
  });

  it("容忍 ```json 包裹与前后闲话", () => {
    const out = parseCandidateTasks(
      '好的，识别结果如下：\n```json\n[{"title":"加导出功能","priority":"P2"}]\n```\n以上。',
    );
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe("P2");
  });

  it("非法 priority 归为 P2；无 JSON 返回空", () => {
    expect(parseCandidateTasks('[{"title":"x","priority":"紧急"}]')[0].priority).toBe("P2");
    expect(parseCandidateTasks("没有任务")).toHaveLength(0);
  });
});

describe("buildJudgeMessages", () => {
  it("system 含仓库列表，user 带序号消息", () => {
    const msgs = buildJudgeMessages(["修一下登录", "今天天气不错"], ["TiMEM-AI/TiMEM-Space"]);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("TiMEM-AI/TiMEM-Space");
    expect(msgs[1].content).toContain("[1] 修一下登录");
    expect(msgs[1].content).toContain("[2] 今天天气不错");
  });
});

describe("filterDuplicates", () => {
  it("阈值以上判重并剔除", () => {
    const out = filterDuplicates(
      [
        { title: "修复登录页白屏", priority: "P1" },
        { title: "新增数据导出", priority: "P2" },
      ],
      ["[P1] 修复 登录页 白屏问题"],
      0.5,
    );
    // “修复登录页白屏” 与现有标题词集重叠足够 → 剔除；导出保留
    expect(out.map((o) => o.title)).toEqual(["新增数据导出"]);
  });
});

// ── shouldFireTick — 静默窗口调度判定 ────────────────────────────────

describe("shouldFireTick — 静默窗口防抖", () => {
  it("缓冲有消息且静默满 quietMs → 触发", () => {
    expect(
      shouldFireTick({
        bufferLen: 3,
        now: 100_000,
        lastCollectTs: 40_000,
        lastRunTs: 99_000,
        quietMs: 60_000,
        intervalMs: 600_000,
      }),
    ).toBe(true);
  });

  it("讨论进行中（未静默满）→ 不触发（防抖：不打断讨论）", () => {
    expect(
      shouldFireTick({
        bufferLen: 5,
        now: 100_000,
        lastCollectTs: 90_000,
        lastRunTs: 0,
        quietMs: 60_000,
        intervalMs: 600_000,
      }),
    ).toBe(false);
  });

  it("缓冲为空 → 只按 intervalMs 兜底触发（保 PR 轮询）", () => {
    const s = {
      bufferLen: 0,
      now: 700_000,
      lastCollectTs: 0,
      lastRunTs: 100_000,
      quietMs: 60_000,
      intervalMs: 600_000,
    };
    expect(shouldFireTick(s)).toBe(true);
    expect(shouldFireTick({ ...s, now: 500_000 })).toBe(false);
  });

  it("collectMessage 更新静默锚点", () => {
    clearBuffer();
    const before = Date.now() - 1000;
    collectMessage({
      messageId: "om_t1",
      chatId: "oc_x",
      senderId: "ou_x",
      text: "记得修账单导出",
      ts: Date.now(),
    });
    expect(lastCollectAnchor()).toBeGreaterThanOrEqual(before);
    clearBuffer();
  });
});

// ── 群 → 候选仓库池（来源群 = 归属参考，跨群串单修复） ─────────────

describe("parseChatRepoMap", () => {
  it("单条目多仓库（| 分隔）", () => {
    const m = parseChatRepoMap("oc_a=org/r1|org/r2");
    expect(m).toEqual({ oc_a: ["org/r1", "org/r2"] });
  });

  it("逗号/换行/全角逗号分隔多群", () => {
    const m = parseChatRepoMap("oc_a=org/r1,oc_b=org/r2\noc_c=org/r3，oc_d=org:r4");
    expect(Object.keys(m)).toEqual(["oc_a", "oc_b", "oc_c", "oc_d"]);
    expect(m["oc_b"]).toEqual(["org/r2"]);
    expect(m["oc_d"]).toEqual(["org:r4"]);
  });

  it("非法条目忽略（无 = / 空 chatId / 空池）", () => {
    expect(parseChatRepoMap("垃圾条目,=org/r1,oc_a=,oc_b=org/r2")).toEqual({
      oc_b: ["org/r2"],
    });
  });

  it("undefined/空串 → 空映射", () => {
    expect(parseChatRepoMap(undefined)).toEqual({});
    expect(parseChatRepoMap("")).toEqual({});
  });
});

describe("groupByChat", () => {
  it("按 chatId 分桶，跨群消息绝不混桶", () => {
    const msgs = [
      { chatId: "oc_a", text: "1" },
      { chatId: "oc_b", text: "2" },
      { chatId: "oc_a", text: "3" },
    ];
    const byChat = groupByChat(msgs);
    expect(byChat.get("oc_a")).toHaveLength(2);
    expect(byChat.get("oc_b")).toHaveLength(1);
  });

  it("缺 chatId 归 * 桶", () => {
    const byChat = groupByChat([{ text: "x" } as { chatId?: string; text: string }]);
    expect(byChat.get("*")).toHaveLength(1);
  });
});

describe("assignRepoForPool", () => {
  it("单仓池直接定仓（LLM 无权选仓，判错也归不出去）", () => {
    expect(assignRepoForPool({ title: "t", priority: "P1", repo: "org/other" }, ["org/only"])).toBe("org/only");
    expect(assignRepoForPool({ title: "t", priority: "P1", confident: false }, ["org/only"])).toBe("org/only");
  });

  it("多仓池：命中候选且未标不确定 → 归属", () => {
    expect(
      assignRepoForPool({ title: "t", priority: "P1", repo: "org/r2", confident: true }, ["org/r1", "org/r2"]),
    ).toBe("org/r2");
    // 旧格式输出（无 confident 字段）仍接受，向后兼容
    expect(assignRepoForPool({ title: "t", priority: "P1", repo: "org/r1" }, ["org/r1", "org/r2"])).toBe("org/r1");
  });

  it("多仓池：confident=false / 未命中 / 缺 repo → 需澄清（宁问不猜，不再静默落 repos[0]）", () => {
    expect(assignRepoForPool({ title: "t", priority: "P1", repo: "org/r1", confident: false }, ["org/r1", "org/r2"])).toBeUndefined();
    expect(assignRepoForPool({ title: "t", priority: "P1", repo: "org/other" }, ["org/r1", "org/r2"])).toBeUndefined();
    expect(assignRepoForPool({ title: "t", priority: "P1" }, ["org/r1", "org/r2"])).toBeUndefined();
  });
});

describe("澄清队列（群内归属确认）", () => {
  afterEach(() => clearPendingCandidates());

  it("add → peek → take 编号全局递增，消费后不可再取", () => {
    const a = addPendingCandidate("oc_a", { title: "修白屏", priority: "P1" }, ["org/r1", "org/r2"]);
    const b = addPendingCandidate("oc_a", { title: "加导出", priority: "P2" }, ["org/r1", "org/r2"]);
    expect(b.no).toBe(a.no + 1);
    expect(peekPendingCandidate("oc_a", a.no)?.title).toBe("修白屏");
    const taken = takePendingCandidate("oc_a", a.no);
    expect(taken?.priority).toBe("P1");
    expect(taken?.pool).toEqual(["org/r1", "org/r2"]);
    expect(takePendingCandidate("oc_a", a.no)).toBeUndefined();
  });

  it("只能在识别它的群里认领（chatId 隔离，防跨群误领）", () => {
    const a = addPendingCandidate("oc_a", { title: "t", priority: "P1" }, ["org/r1"]);
    expect(peekPendingCandidate("oc_b", a.no)).toBeUndefined();
    expect(dropPendingCandidate("oc_b", a.no)).toBe(false);
    expect(dropPendingCandidate("oc_a", a.no)).toBe(true);
  });

  it("超限淘汰最老项（上限 50）", () => {
    for (let i = 0; i < 50; i++) addPendingCandidate("oc_a", { title: `t${i}`, priority: "P2" }, ["org/r1"]);
    const extra = addPendingCandidate("oc_a", { title: "new", priority: "P1" }, ["org/r1"]);
    const firstNo = extra.no - 50; // 本轮最早一项（t0）已被挤出
    expect(peekPendingCandidate("oc_a", firstNo)).toBeUndefined();
    expect(peekPendingCandidate("oc_a", firstNo + 1)?.title).toBe("t1");
    expect(peekPendingCandidate("oc_a", extra.no)?.title).toBe("new");
  });
});

describe("buildJudgeMessages — 多候选池置信规则", () => {
  it("prompt 含 confident 规则与候选列表", () => {
    const msgs = buildJudgeMessages(["修一下登录"], ["org/r1", "org/r2"]);
    expect(msgs[0].content).toContain("confident");
    expect(msgs[0].content).toContain("org/r1, org/r2");
  });
});

// ── 判定收紧（#25 误报回归）：提示词排除清单 + confident 闸门 ─────────

describe("buildJudgeMessages — 判定收紧", () => {
  it("prompt 包含准入标准与报告类排除清单", () => {
    const msgs = buildJudgeMessages(["x"], ["org/r1"]);
    const sys = msgs[0].content;
    expect(sys).toContain("准入标准");
    expect(sys).toContain("报告/汇报/总结");
    expect(sys).toContain("宁漏勿滥");
    expect(sys).toContain("confident 填 false");
  });
});

describe("confident=false 候选闸门", () => {
  it("parseCandidateTasks 保留 confident 字段（供上层过滤）", () => {
    const out = parseCandidateTasks(
      `[{"title":"报告类误报","priority":"P2","confident":false},{"title":"真任务","priority":"P1","confident":true}]`,
    );
    expect(out).toHaveLength(2);
    expect(out[0].confident).toBe(false);
    expect(out[1].confident).toBe(true);
  });
});

// ── 飞书先行：开关 + 澄清候选携带任务 guid ──────────────────────────

describe("feishuFirstEnabled — TASK_FEISHU_FIRST 开关", () => {
  const saved = process.env["TASK_FEISHU_FIRST"];
  const set = (v?: string) => {
    if (v === undefined) delete process.env["TASK_FEISHU_FIRST"];
    else process.env["TASK_FEISHU_FIRST"] = v;
  };

  it("未设置/1 → 默认开启（先建飞书任务，归属+执行者齐备再建工单）", () => {
    set(undefined);
    expect(feishuFirstEnabled()).toBe(true);
    set("1");
    expect(feishuFirstEnabled()).toBe(true);
  });

  it("0/false/off（大小写不敏感）→ 关闭（回到汇总即建工单旧链路）", () => {
    for (const v of ["0", "false", "OFF", "False"]) {
      set(v);
      expect(feishuFirstEnabled()).toBe(false);
    }
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["TASK_FEISHU_FIRST"];
    else process.env["TASK_FEISHU_FIRST"] = saved;
  });
});

describe("澄清候选 — 飞书任务 guid 携带与按编号跨群查", () => {
  afterEach(() => clearPendingCandidates());

  it("addPendingCandidate 记录 feishuTaskGuid；findPendingCandidateByNo 不限群可查且只看不取", () => {
    const item = addPendingCandidate(
      "oc_a",
      { title: "修白屏", priority: "P1", feishuTaskGuid: "tg-42" },
      ["AIGility/x"],
    );
    expect(item.feishuTaskGuid).toBe("tg-42");
    // 不限群（执行者安排可在任意成员发起）；peek 校验 chatId 的行为不受影响
    expect(findPendingCandidateByNo(item.no)?.feishuTaskGuid).toBe("tg-42");
    expect(findPendingCandidateByNo(item.no)).toBeDefined();
    expect(peekPendingCandidate("oc_b", item.no)).toBeUndefined();
    // 只看不取：不消费队列
    expect(peekPendingCandidate("oc_a", item.no)).toBeDefined();
    expect(findPendingCandidateByNo(99999)).toBeUndefined();
  });
});
