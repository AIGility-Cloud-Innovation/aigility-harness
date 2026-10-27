/** pingcode-intake-sync 单测：归属映射纯函数 + 主流程（mock fetch）建单/关联/跳过/落映射。 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pcProjectForAttribution,
  resolveAttribution,
  syncPingcodeIntake,
  feishuGuidOf,
} from "./pingcode-intake-sync.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("pcProjectForAttribution（2026-10-25 拍板口径）", () => {
  it("TiMEM-AI/TiMEM-Space → TAI（大小写与 -/_ 归一）", () => {
    expect(pcProjectForAttribution("TiMEM-AI/TiMEM-Space")).toBe("TAI");
    expect(pcProjectForAttribution("timem_ai/timem_space")).toBe("TAI");
  });
  it("TiMEM-AI 其他仓库 → TYY", () => {
    expect(pcProjectForAttribution("TiMEM-AI/timem_frontend")).toBe("TYY");
    expect(pcProjectForAttribution("TiMEM-AI/timem-platform-backend")).toBe("TYY");
  });
  it("AIGility-Cloud-Innovation 不做同步；未知组织不猜", () => {
    expect(pcProjectForAttribution("AIGility-Cloud-Innovation/nx-telecom-opc-platform")).toBeUndefined();
    expect(pcProjectForAttribution("some-org/repo")).toBeUndefined();
  });
  it("裸仓库名只认 timem-space→TAI，其余不建", () => {
    expect(pcProjectForAttribution("TiMEM-Space")).toBe("TAI");
    expect(pcProjectForAttribution("timem_frontend")).toBeUndefined();
    expect(pcProjectForAttribution(undefined)).toBeUndefined();
  });
});

describe("resolveAttribution / feishuGuidOf", () => {
  it("projectRef 优先，标题 [org/repo] 回落", () => {
    expect(resolveAttribution({ title: "【agent】[TiMEM-AI/timem-frontend] 优化", projectRef: "TiMEM-AI/timem-platform-backend" })).toBe("TiMEM-AI/timem-platform-backend");
    expect(resolveAttribution({ title: "【agent】[TiMEM-AI/timem-frontend] 优化" })).toBe("TiMEM-AI/timem-frontend");
    expect(resolveAttribution({ title: "纯中文标题没有归属" })).toBeUndefined();
  });
  it("feishuGuidOf：links 优先，origin 回落", () => {
    expect(feishuGuidOf({ links: { "feishu-task": { guid: "g1" } } })).toBe("g1");
    expect(feishuGuidOf({ origin: { provider: "feishu-task", guid: "g2" } })).toBe("g2");
    expect(feishuGuidOf({ origin: { provider: "gitea", guid: "g3" } })).toBeUndefined();
  });
});

describe("syncPingcodeIntake", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pci-"));
    mkdirSync(join(dir, "config"), { recursive: true });
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
  const writeProjection = (m: Record<string, string>) =>
    writeFileSync(join(dir, "config", "board-projection.local.json"), JSON.stringify(m));
  /** PingCode 假 API：项目/类型/建单/回读。 */
  const mockPcApis = () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: { method?: string }) => {
      const u = String(url);
      if (u.includes("/auth/token")) return jsonRes({ access_token: "t" });
      if (u.endsWith("/projects")) return jsonRes({ values: [{ id: "pTYY", identifier: "TYY" }, { id: "pTAI", identifier: "TAI" }] });
      if (u.includes("/workitem_types")) return jsonRes({ values: [{ id: "typeTask", name: "任务" }, { id: "typeBug", name: "缺陷" }] });
      if (u.endsWith("/workitems") && init?.method === "POST") return jsonRes({ id: "w-new", whole_identifier: "TYY-140" });
      if (u.includes("/pjm/workitems/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d")) return jsonRes({ whole_identifier: "TYY-99" });
      return jsonRes({});
    });
  };
  const task = (uid: string, extra: Record<string, unknown> = {}) => ({
    uid,
    title: "测试任务标题",
    status: "planned",
    ...extra,
  });

  it("P 组未映射 TiMEM 卡：建单 + 落映射，提交体带项目/类型/描述", async () => {
    mockPcApis();
    writeProjection({ u1: "P", u2: "C", u3: "D" });
    const reg = {
      list: () => [
        task("u1", { title: "【agent】[TiMEM-AI/timem-frontend] 优化登录", links: { "feishu-task": { guid: "g1" } } }),
        task("u2", { links: { "feishu-task": { guid: "g2" } } }),
        task("u3", { links: { "feishu-task": { guid: "g3" } } }),
      ],
    };
    const r = await syncPingcodeIntake(reg, dir);
    expect(r.created).toEqual([`TYY-140「${"【agent】[TiMEM-AI/timem-frontend] 优化登录".slice(0, 20)}」`]);
    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "POST");
    expect(posts.length).toBe(1);
    const body = JSON.parse((posts[0][1] as { body: string }).body);
    expect(body.project_id).toBe("pTYY");
    expect(body.type_id).toBe("typeTask");
    expect(body.description).toContain("https://www.feishu.cn/task/g1");
    expect(body.description).toContain("台账：u1");
    const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf-8"));
    expect(map).toEqual([{ feishu_guid: "g1", pingcode: "TYY-140", feishu_summary: "【agent】[TiMEM-AI/timem-frontend] 优化登录".slice(0, 40) }]);
  });

  it("Space 仓库进 TAI；已在映射表/非 P 组零 API 调用", async () => {
    writeFileSync(join(dir, "map.json"), JSON.stringify([{ feishu_guid: "g-mapped", pingcode: "TYY-1" }]));
    mockPcApis();
    writeProjection({ u1: "P", u2: "P" });
    const reg = {
      list: () => [
        task("u1", { title: "【agent】[TiMEM-AI/TiMEM-Space] 优化", links: { "feishu-task": { guid: "g-new" } } }),
        task("u2", { links: { "feishu-task": { guid: "g-mapped" } } }),
        task("u3", { links: { "feishu-task": { guid: "g-c" } } }),
      ],
    };
    const r = await syncPingcodeIntake(reg, dir);
    expect(r.created).toHaveLength(1);
    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "POST");
    expect(JSON.parse((posts[0][1] as { body: string }).body).project_id).toBe("pTAI");
    const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf-8"));
    expect(map).toHaveLength(2);
    expect(map.some((e: { feishu_guid: string }) => e.feishu_guid === "g-mapped")).toBe(true);
  });

  it("AIGility 与归属不明的卡跳过不建，跳过原因只记一次", async () => {
    mockPcApis();
    writeProjection({ u1: "P", u2: "P" });
    const reg = {
      list: () => [
        task("u1", { title: "【agent】[AIGility-Cloud-Innovation/nx-telecom-opc-platform] 改", links: { "feishu-task": { guid: "g-aig" } } }),
        task("u2", { title: "没有归属标记", links: { "feishu-task": { guid: "g-none" } } }),
      ],
    };
    const first = await syncPingcodeIntake(reg, dir);
    expect(first.created).toEqual([]);
    expect(first.skipped).toHaveLength(2);
    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "POST");
    expect(posts).toHaveLength(0);
    const sigs = JSON.parse(readFileSync(join(dir, "map.state.json"), "utf-8"));
    expect(sigs["skip:g-none"]).toContain("归属不明");
    // 同卡同因二拍不再刷
    const errSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await syncPingcodeIntake(reg, dir);
    errSpy.mockRestore();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("描述已含 PingCode 链接：只解析工单号落映射，不重复建单", async () => {
    mockPcApis();
    writeProjection({ u1: "P" });
    const reg = {
      list: () => [
        task("u1", {
          title: "已手工关联的任务",
          description: "详见 https://aici.pingcode.com/pjm/workitems/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
          links: { "feishu-task": { guid: "g-link" } },
        }),
      ],
    };
    const r = await syncPingcodeIntake(reg, dir);
    expect(r.linked).toEqual(["TYY-99「已手工关联的任务」"]);
    const posts = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, i]) => (i as { method?: string })?.method === "POST");
    expect(posts).toHaveLength(0);
    const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf-8"));
    expect(map).toEqual([{ feishu_guid: "g-link", pingcode: "TYY-99", feishu_summary: "已手工关联的任务" }]);
  });

  it("完成/取消卡不建单；凭据未配置旁路返回空", async () => {
    writeProjection({ u1: "P", u2: "P" });
    const reg = {
      list: () => [
        task("u1", { status: "done", links: { "feishu-task": { guid: "g-done" } } }),
        task("u2", { status: "cancelled", links: { "feishu-task": { guid: "g-cancel" } } }),
      ],
    };
    const r = await syncPingcodeIntake(reg, dir);
    expect(r.created).toEqual([]);
    delete process.env.PINGCODE_CLIENT_ID;
    const r2 = await syncPingcodeIntake({ list: () => [task("u1", { links: { "feishu-task": { guid: "g-x" } } })] }, dir);
    expect(r2).toEqual({ created: [], linked: [], skipped: [] });
  });
});
