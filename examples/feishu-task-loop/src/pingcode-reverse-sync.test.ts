/** pingcode-reverse-sync 单测：交付PR闸门、无PR问询防重与人工确认补关、PC描述取证与即时确认。 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  syncPingcodeClosures,
  sanitizeCommandText,
  recordClosureConfirmation,
  appendPrToFeishuDescription,
} from "./pingcode-reverse-sync.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("syncPingcodeClosures", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prs-"));
    mkdirSync(dir, { recursive: true });
    process.env.PINGCODE_CLIENT_ID = "cid";
    process.env.PINGCODE_CLIENT_SECRET = "csec";
    delete process.env.PINGCODE_SYNC_MAP;
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });
  const okCall = async () => ({ ok: true, value: { code: 0 } });
  /** 假台账：list/transition 行为可编排 */
  const fakeRegistry = (status: string, onTransition?: (to: string) => boolean) => ({
    list: () => [
      { uid: "u1", status, note: "交付 https://git.aigility.cloud/org/repo/pulls/7", links: { "feishu-task": { guid: "g1" } }, origin: { provider: "feishu-task", guid: "g1" } },
    ],
    transition: (uid: string, to: string) => (onTransition ? onTransition(to) : { ok: true }),
  });
  const setupMap = (entries: Array<{ feishu_guid: string; pingcode: string }>) => {
    writeFileSync(join(dir, "map.json"), JSON.stringify(entries));
    process.env.PINGCODE_SYNC_MAP = join(dir, "map.json");
  };
  const mockPc = (stateName: string) => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/auth/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      if (u.endsWith("/projects")) return new Response(JSON.stringify({ values: [{ id: "p1", identifier: "TYY" }] }), { status: 200 });
      if (u.includes("/workitems?")) return new Response(JSON.stringify({ values: [{ id: "w1", whole_identifier: "TYY-101" }] }), { status: 200 });
      return new Response(JSON.stringify({ state: { name: stateName } }), { status: 200 });
    });
  };
  const mergedGiteaCall = async (req: { path?: string }) => ({
    ok: true,
    value: { status: 200, data: { merged: req.path?.endsWith("/pulls/7") === true } },
  });
  /** 未合并 mock：PR 存在但 merged=false（问询用例语义） */
  const unmergedGiteaCall = async () => ({ ok: true, value: { status: 200, data: { merged: false } } });
  it("PC 关闭且PR已合并 → 台账 done + 飞书标完成", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    const transitions: string[] = [];
    const reg = fakeRegistry("dispatched", (to) => { transitions.push(to); return { ok: true }; });
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall });
    expect(changes).toEqual(["TYY-101 PC已关闭 → 台账done+飞书已完成"]);
    expect(transitions).toEqual(["done"]);
  });
  it("PC 进行中 → 不动", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("进行中");
    const reg = fakeRegistry("dispatched");
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall });
    expect(changes).toEqual([]);
  });
  it("台账已 done → 跳过（不发任何 PC 请求）", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    const reg = fakeRegistry("done");
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall });
    expect(changes).toEqual([]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
  it("直达 done 不成时经 review 两跳", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("已发布");
    const calls: string[] = [];
    const reg = {
      list: () => [{ uid: "u1", status: "running", note: "交付 https://git.aigility.cloud/org/repo/pulls/7", links: { "feishu-task": { guid: "g1" } } }],
      transition: (uid: string, to: string, from?: string) => {
        calls.push(from ? `${from}→${to}` : to);
        return { ok: to === "review" || from === "review" }; // 直达 done 失败，review/done(review) 成
      },
    };
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall });
    expect(changes.length).toBe(1);
    expect(calls).toContain("review");
    expect(calls).toContain("review→done");
  });
  it("映射卡不在台账 → 跳过不猜", async () => {
    setupMap([{ feishu_guid: "ghost", pingcode: "TYY-999" }]);
    mockPc("关闭");
    const reg = fakeRegistry("dispatched");
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall });
    expect(changes).toEqual([]);
  });
  it("未配凭据 → 空", async () => {
    delete process.env.PINGCODE_CLIENT_ID;
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    const reg = fakeRegistry("dispatched");
    expect(await syncPingcodeClosures(reg, dir, okCall, { giteaCall: mergedGiteaCall })).toEqual([]);
  });
  it("PC 关闭但PR未合并 → 问询不改卡，且只问一次", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    const transitions: string[] = [];
    const notified: string[] = [];
    const reg = fakeRegistry("dispatched", (to) => { transitions.push(to); return { ok: true }; });
    const options = { giteaCall: unmergedGiteaCall, notify: async (text: string) => { notified.push(text); } };
    const changes = await syncPingcodeClosures(reg, dir, okCall, options);
    expect(changes).toEqual(["TYY-101 已关闭但无交付PR → 已问询"]);
    expect(notified).toEqual([expect.stringContaining("确认关单 TYY-101")]);
    expect(transitions).toEqual([]);
    const repeated = await syncPingcodeClosures(reg, dir, okCall, options);
    expect(repeated).toEqual([]);
    expect(notified).toHaveLength(1);
    expect(readFileSync(join(dir, "map.state.json"), "utf-8")).toContain("pc-closed-no-pr");
  });
  it("回复确认关单 → 下一拍补关台账和飞书卡", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    writeFileSync(join(dir, "map.state.json"), JSON.stringify({ "g1:pc-closed-no-pr": "pc-closed-no-pr" }));
    const transitions: string[] = [];
    const notified: string[] = [];
    const reg = fakeRegistry("dispatched", (to) => { transitions.push(to); return { ok: true }; });
    const changes = await syncPingcodeClosures(reg, dir, okCall, {
      giteaCall: mergedGiteaCall,
      notify: async (text: string) => { notified.push(text); },
      receivedMessages: ["确认关单 TYY-101"],
    });
    expect(changes).toEqual(["TYY-101 PC已关闭 → 台账done+飞书已完成"]);
    expect(transitions).toEqual(["done"]);
    expect(notified).toEqual([]);
  });

  // ── 2026-10-27：PC 描述取证 + 确认双通道（零宽字符实录修复）──────────────
  it("sanitizeCommandText 剥零宽/不可见字符", () => {
    expect(sanitizeCommandText("确认关单 TYY-132\u200d")).toBe("确认关单 TYY-132");
    expect(sanitizeCommandText(" 确认关单\u2060 TYY-130\ufeff ")).toBe("确认关单 TYY-130");
  });
  it("带零宽字符的确认消息也能消费（U+200D 尾随实录）", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    writeFileSync(join(dir, "map.state.json"), JSON.stringify({ "g1:pc-closed-no-pr": "pc-closed-no-pr" }));
    const reg = fakeRegistry("dispatched");
    const changes = await syncPingcodeClosures(reg, dir, okCall, {
      giteaCall: unmergedGiteaCall,
      receivedMessages: ["确认关单 TYY-101\u200d"],
    });
    expect(changes).toEqual(["TYY-101 PC已关闭 → 台账done+飞书已完成"]);
  });
  it("台账无PR但PC描述有已合并PR → 取证放行并回写飞书描述与台账note", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/auth/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      if (u.endsWith("/projects")) return new Response(JSON.stringify({ values: [{ id: "p1", identifier: "TYY" }] }), { status: 200 });
      if (u.includes("/workitems?")) return new Response(JSON.stringify({ values: [{ id: "w1", whole_identifier: "TYY-101" }] }), { status: 200 });
      return new Response(JSON.stringify({ state: { name: "关闭" }, description: "交付见 https://git.aigility.cloud/org/repo/pulls/9" }), { status: 200 });
    });
    const noteUpdates: string[] = [];
    const reg = {
      list: () => [{ uid: "u1", status: "review", note: "已完成", links: { "feishu-task": { guid: "g1" } } }],
      transition: () => ({ ok: true }),
      update: (_uid: string, patch: { note?: string }) => { noteUpdates.push(patch.note ?? ""); return { ok: true }; },
    };
    const gitea = async (req: { path?: string }) => ({ ok: true, value: { status: 200, data: { merged: req.path?.endsWith("/pulls/9") === true } } });
    const feishuCalls: Array<Record<string, unknown>> = [];
    const feishuCall = async (req: Record<string, unknown>) => {
      feishuCalls.push(req);
      return { ok: true, value: { code: 0, data: { task: { description: "现有描述" } } } };
    };
    const changes = await syncPingcodeClosures(reg, dir, feishuCall, { giteaCall: gitea });
    expect(changes[0]).toContain("取证自 PC 描述");
    const descPatch = feishuCalls.find((r) => (r.body as { update_fields?: string[] })?.update_fields?.[0] === "description");
    expect((descPatch?.body as { task?: { description?: string } })?.task?.description).toContain("交付 PR：https://git.aigility.cloud/org/repo/pulls/9");
    expect(noteUpdates[0]).toContain("pulls/9");
  });
  it("PC 描述有 PR 但均未合并 → 问询提示", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/auth/token")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      if (u.endsWith("/projects")) return new Response(JSON.stringify({ values: [{ id: "p1", identifier: "TYY" }] }), { status: 200 });
      if (u.includes("/workitems?")) return new Response(JSON.stringify({ values: [{ id: "w1", whole_identifier: "TYY-101" }] }), { status: 200 });
      return new Response(JSON.stringify({ state: { name: "关闭" }, description: "未合并 https://git.aigility.cloud/org/repo/pulls/9" }), { status: 200 });
    });
    const notified: string[] = [];
    const reg = fakeRegistry("dispatched");
    const changes = await syncPingcodeClosures(reg, dir, okCall, {
      giteaCall: unmergedGiteaCall,
      notify: async (text: string) => { notified.push(text); },
    });
    expect(changes).toEqual(["TYY-101 已关闭但无交付PR → 已问询"]);
    expect(notified[0]).toContain("均未合并");
  });
  it("recordClosureConfirmation 即时落标记 → 下拍无消息也补关，并清理标记", async () => {
    setupMap([{ feishu_guid: "g1", pingcode: "TYY-101" }]);
    mockPc("关闭");
    writeFileSync(join(dir, "map.state.json"), JSON.stringify({ "g1:pc-closed-no-pr": "pc-closed-no-pr" }));
    expect(recordClosureConfirmation(dir, "TYY-101").ok).toBe(true);
    expect(recordClosureConfirmation(dir, "TYY-404").ok).toBe(false);
    const reg = fakeRegistry("dispatched");
    const changes = await syncPingcodeClosures(reg, dir, okCall, { giteaCall: unmergedGiteaCall });
    expect(changes).toEqual(["TYY-101 PC已关闭 → 台账done+飞书已完成"]);
    const sigs = JSON.parse(readFileSync(join(dir, "map.state.json"), "utf-8"));
    expect(sigs["g1:pc-confirm"]).toBeUndefined();
  });
  it("appendPrToFeishuDescription 幂等：描述已含链接不再 PATCH", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const call = async (req: Record<string, unknown>) => {
      calls.push(req);
      return { ok: true, value: { code: 0, data: { task: { description: "x\n交付 PR：https://git.aigility.cloud/o/r/pulls/9" } } } };
    };
    const ok = await appendPrToFeishuDescription(call, "g1", ["https://git.aigility.cloud/o/r/pulls/9"]);
    expect(ok).toBe(true);
    expect(calls.some((r) => r.method === "PATCH")).toBe(false);
  });
});
