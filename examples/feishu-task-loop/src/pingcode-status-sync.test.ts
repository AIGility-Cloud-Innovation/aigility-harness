/** pingcode-status-sync 单测：截面映射纯函数 + 主流程（mock fetch）签名防重/完成关闭/挂起跳过。 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pcStateForSection, syncPingcodeStatuses } from "./pingcode-status-sync.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pcStateForSection", () => {
  it("P/D/C 三截面映射实测流转集内的状态", () => {
    expect(pcStateForSection("P 计划中")).toBe("打开");
    expect(pcStateForSection("D 执行中")).toBe("进行中");
    expect(pcStateForSection("C 待测试")).toBe("已提测");
  });
  it("挂起/A/未知截面返回 undefined（不联动）", () => {
    expect(pcStateForSection("挂起")).toBeUndefined();
    expect(pcStateForSection("A 待修复")).toBeUndefined();
    expect(pcStateForSection("")).toBeUndefined();
  });
});

describe("syncPingcodeStatuses", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pcs-"));
    writeFileSync(join(dir, "map.json"), JSON.stringify([
      { feishu_guid: "g1", pingcode: "TYY-101" },
      { feishu_guid: "g2", pingcode: "TYY-102" },
      { feishu_guid: "g3", pingcode: "TAI-196" },
    ]));
    process.env.PINGCODE_CLIENT_ID = "cid";
    process.env.PINGCODE_CLIENT_SECRET = "csec";
    process.env.PINGCODE_SYNC_MAP = join(dir, "map.json");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env.PINGCODE_SYNC_MAP;
  });
  const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  /** 有状态 mock：PATCH 真正改变卡现态（回读返回 PATCH 后的态），验证完整写入链路。 */
  const mockPcApis = (initialState = "打开") => {
    const stateNames: Record<string, string> = { s1: "打开", s2: "进行中", s3: "已提测", s4: "关闭" };
    const cardState: Record<string, string> = { w1: initialState, w2: initialState, w3: initialState };
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/auth/token")) return jsonRes({ access_token: "t" });
      if (u.endsWith("/projects")) return jsonRes({ values: [{ id: "p1", identifier: "TYY" }, { id: "p2", identifier: "TAI" }] });
      if (u.includes("/workitem_states")) return jsonRes({ values: [{ id: "s1", name: "打开" }, { id: "s2", name: "进行中" }, { id: "s3", name: "已提测" }, { id: "s4", name: "关闭" }] });
      if (u.includes("/workitems?")) return jsonRes({ values: [{ id: "w1", whole_identifier: "TYY-101" }, { id: "w2", whole_identifier: "TYY-102" }, { id: "w3", whole_identifier: "TAI-196" }] });
      const wid = u.split("/workitems/")[1] ?? "";
      if (init?.method === "PATCH") {
        const sid = (JSON.parse(init.body ?? "{}") as { state_id?: string }).state_id ?? "";
        cardState[wid] = stateNames[sid] ?? cardState[wid] ?? "打开";
        return jsonRes({ state: { name: cardState[wid] } });
      }
      return jsonRes({ state: { name: cardState[wid] ?? initialState } }); // GET 详情
    });
  };
  it("签名首拍：已是期望态跳过，需变的 PATCH 并写 state 文件", async () => {
    mockPcApis("打开"); // 卡初始全是「打开」：g1(P→打开) 无需变更
    const snap = new Map([
      ["g1", { section: "P 计划中", completed: false }],
      ["g2", { section: "D 执行中", completed: false }],
      ["g3", { section: "C 待测试", completed: false }],
    ]);
    const changes = await syncPingcodeStatuses({ snapshot: snap, repoRoot: dir });
    expect(changes).toEqual(["TYY-102 → 进行中", "TAI-196 → 已提测"]);
    const sigs = JSON.parse(readFileSync(join(dir, "map.state.json"), "utf-8"));
    expect(sigs["g1"]).toBe("打开"); // 已是期望态也记账
    expect(sigs["g2"]).toBe("进行中");
    expect(sigs["g2:sid"]).toBe("w2"); // 工单 id 缓存落盘
  });
  it("签名不变零 PATCH（幂等）", async () => {
    mockPcApis("打开");
    const snap = new Map([["g1", { section: "D 执行中", completed: false }]]);
    await syncPingcodeStatuses({ snapshot: snap, repoRoot: dir }); // 打开→进行中：恰 1 次 PATCH
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "PATCH").length).toBe(1);
    (fetch as ReturnType<typeof vi.fn>).mockClear();
    await syncPingcodeStatuses({ snapshot: new Map([["g1", { section: "D 执行中", completed: false }]]), repoRoot: dir });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "PATCH").length).toBe(0);
  });
  it("完成快照 → 关闭", async () => {
    mockPcApis("打开");
    const snap = new Map([["g1", { section: "C 待测试", completed: true }]]);
    const changes = await syncPingcodeStatuses({ snapshot: snap, repoRoot: dir });
    expect(changes).toEqual(["TYY-101 → 关闭"]);
  });
  it("快照无此卡 → 跳过不猜", async () => {
    mockPcApis("打开");
    const changes = await syncPingcodeStatuses({ snapshot: new Map(), repoRoot: dir });
    expect(changes).toEqual([]);
  });
  it("挂起截面不联动", async () => {
    mockPcApis("打开");
    const snap = new Map([["g1", { section: "挂起", completed: false }]]);
    const changes = await syncPingcodeStatuses({ snapshot: snap, repoRoot: dir });
    expect(changes).toEqual([]);
  });
  it("未配凭据静默跳过", async () => {
    delete process.env.PINGCODE_CLIENT_ID;
    const changes = await syncPingcodeStatuses({ snapshot: new Map(), repoRoot: dir });
    expect(changes).toEqual([]);
  });
});
