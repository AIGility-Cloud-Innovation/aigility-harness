import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFeishuUrl,
  buildAuthorizeUrl,
  isTokenExpired,
  msUntilExpiry,
  extractAuthCode,
  readTokenEnv,
  resolveTokenStorePath,
  getFreshUserToken,
  resetUserTokenCache,
  type TokenEnv,
} from "./feishu-api.js";

describe("buildFeishuUrl", () => {
  it("拼接无 query 的 URL", () => {
    expect(buildFeishuUrl("https://open.feishu.cn", "/open-apis/task/v2/tasks")).toBe(
      "https://open.feishu.cn/open-apis/task/v2/tasks",
    );
  });

  it("拼接 query 并做 URI 编码", () => {
    const url = buildFeishuUrl("https://open.feishu.cn", "/open-apis/task/v2/tasks", {
      page_size: 5,
      user_id_type: "open_id",
      q: "中文 值",
    });
    expect(url).toBe(
      "https://open.feishu.cn/open-apis/task/v2/tasks?page_size=5&user_id_type=open_id&q=" +
        encodeURIComponent("中文 值"),
    );
  });

  it("baseUrl 末尾斜杠归一化", () => {
    expect(buildFeishuUrl("https://open.feishu.cn/", "/x")).toBe(
      "https://open.feishu.cn/x",
    );
  });

  it("path 不以 / 开头时抛错", () => {
    expect(() => buildFeishuUrl("https://open.feishu.cn", "open-apis/x")).toThrow();
  });
});

describe("isTokenExpired", () => {
  it("未过期返回 false（含 60s 提前量内不算过期）", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(isTokenExpired(future)).toBe(false);
  });

  it("60s 缓冲内已视为过期", () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    expect(isTokenExpired(soon)).toBe(true);
  });

  it("过去时间返回 true，非法串返回 true", () => {
    expect(isTokenExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isTokenExpired("not-a-date")).toBe(true);
  });
});

describe("msUntilExpiry", () => {
  it("返回距过期的剩余毫秒", () => {
    const t = Date.parse("2026-01-01T00:00:00Z");
    expect(msUntilExpiry("2026-01-01T00:10:00Z", t)).toBe(600_000);
  });

  it("非法串返回 -Infinity（等同于早已过期，触发续期）", () => {
    expect(msUntilExpiry("not-a-date")).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ── getFreshUserToken — 临期自动续期 ────────────────────────────────
//
// 回归背景：user_access_token 到期后，task:task / bitable 等用户身份域接口
// 会开始报错；而「等彻底过期再 refresh」有让 refresh_token 一起失效的风险。
// 本组断言：临期即提前续期、续期结果回写落盘、并发只续一次。

describe("getFreshUserToken — 临期提前续期", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetUserTokenCache(); // 进程内缓存跨用例共享，必须逐用例清空
    vi.restoreAllMocks();
  });

  async function store(rec: Record<string, unknown>): Promise<{ env: TokenEnv; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "feishu-token-"));
    const path = join(dir, "user_token.local.json");
    await writeFile(path, JSON.stringify(rec), "utf8");
    return { env: { appId: "cli_t", appSecret: "s", tokenStorePath: path }, path };
  }

  /** 假飞书：app_access_token + refresh_access_token 两个端点 */
  function mockFeishu(opts: { refreshOk?: boolean; onRefresh?: () => void } = {}) {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes("app_access_token")
        ? { code: 0, app_access_token: "app_tok" }
        : opts.refreshOk === false
          ? { code: 20024, msg: "refresh token expired" }
          : {
              code: 0,
              data: {
                access_token: "new_user_tok",
                refresh_token: "new_refresh_tok",
                expires_in: 7200,
                scope: "task:task",
              },
            };
      if (!u.includes("app_access_token")) opts.onRefresh?.();
      return { json: async () => body } as Response;
    }) as typeof fetch;
    return calls;
  }

  it("token 仍充裕时直接用缓存，不发任何网络请求", async () => {
    const { env } = await store({
      access_token: "fresh_tok",
      refresh_token: "r1",
      expires_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
    });
    const calls = mockFeishu();
    const tok = await getFreshUserToken(env, "https://open.feishu.cn");
    expect(tok).toBe("fresh_tok");
    expect(calls).toEqual([]);
  });

  it("进入 30 分钟临期窗口即续期，并回写落盘 + 返回新 token", async () => {
    const { env, path } = await store({
      access_token: "stale_tok",
      refresh_token: "r1",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    mockFeishu();
    const tok = await getFreshUserToken(env, "https://open.feishu.cn");
    expect(tok).toBe("new_user_tok");
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.access_token).toBe("new_user_tok");
    expect(written.refresh_token).toBe("new_refresh_tok"); // refresh_token 轮换须落盘
    expect(Date.parse(written.expires_at)).toBeGreaterThan(Date.now() + 3600_000);
  });

  it("续期后再次调用命中进程内缓存，不重复打接口", async () => {
    const { env } = await store({
      access_token: "stale_tok",
      refresh_token: "r1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const calls = mockFeishu();
    await getFreshUserToken(env, "https://open.feishu.cn");
    const before = calls.length;
    await getFreshUserToken(env, "https://open.feishu.cn");
    expect(calls.length).toBe(before);
  });

  it("refresh_token 失效时报错含 OAuth 重新授权引导（不静默返回坏 token）", async () => {
    const { env } = await store({
      access_token: "expired_tok",
      refresh_token: "dead",
      expires_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    mockFeishu({ refreshOk: false });
    await expect(getFreshUserToken(env, "https://open.feishu.cn")).rejects.toThrow(/OAuth/);
  });

  it("并发调用只触发一次 refresh（refresh_token 轮换，重复续期会互相作废）", async () => {
    const { env } = await store({
      access_token: "stale_tok",
      refresh_token: "r1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    let refreshCount = 0;
    mockFeishu({ onRefresh: () => { refreshCount += 1; } });
    const results = await Promise.all([
      getFreshUserToken(env, "https://open.feishu.cn"),
      getFreshUserToken(env, "https://open.feishu.cn"),
      getFreshUserToken(env, "https://open.feishu.cn"),
    ]);
    expect(refreshCount).toBe(1);
    expect(new Set(results)).toEqual(new Set(["new_user_tok"]));
  });
});

describe("buildAuthorizeUrl", () => {
  it("默认参数生成标准授权链接（回调/scope 走约定默认，state 自动生成）", () => {
    const a = buildAuthorizeUrl({ appId: "cli_a123" });
    expect(a.redirectUri).toBe("http://localhost:18080/callback");
    expect(a.scopes).toBe("task:task:read task:task:write task:section:read task:section:write");
    expect(a.state).toMatch(/^[0-9a-f]{32}$/);
    expect(a.url).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize" +
        `?app_id=cli_a123` +
        `&redirect_uri=${encodeURIComponent("http://localhost:18080/callback")}` +
        `&scope=${encodeURIComponent("task:task:read task:task:write task:section:read task:section:write")}` +
        `&state=${a.state}`,
    );
  });

  it("scopes 数组合并为空格分隔（飞书约定逗号会报 20043）", () => {
    const a = buildAuthorizeUrl({ appId: "x", scopes: ["a:b:c", "d:e"] });
    expect(a.scopes).toBe("a:b:c d:e");
    expect(a.url).toContain(`scope=${encodeURIComponent("a:b:c d:e")}`);
  });

  it("自定义 state 与 redirectUri 生效", () => {
    const a = buildAuthorizeUrl({
      appId: "x",
      state: "my-state",
      redirectUri: "http://localhost:9999/cb",
    });
    expect(a.state).toBe("my-state");
    expect(a.url).toContain("state=my-state");
    expect(a.url).toContain(`redirect_uri=${encodeURIComponent("http://localhost:9999/cb")}`);
  });
});

describe("extractAuthCode", () => {
  it("从回调 URL 提取 code", () => {
    expect(
      extractAuthCode("http://localhost:18080/callback?code=AbCd123&state=r2"),
    ).toBe("AbCd123");
  });

  it("裸 code 原样返回", () => {
    expect(extractAuthCode("AbCd123")).toBe("AbCd123");
  });

  it("非法输入返回 null", () => {
    expect(extractAuthCode("http://localhost:18080/callback?state=r2")).toBeNull();
    expect(extractAuthCode("bad code!")).toBeNull();
  });
});

describe("readTokenEnv", () => {
  it("缺省/相对 token store 路径相对仓库根解析（不随 cwd 漂移）", () => {
    const saved = process.env.FEISHU_USER_TOKEN_STORE;
    delete process.env.FEISHU_USER_TOKEN_STORE;
    const p = readTokenEnv().tokenStorePath;
    // 解析后的绝对路径应落在仓库根 feishu/ 下（本测试文件位于 <root>/packages/layer-action/src）
    expect(p).toMatch(/feishu[/\\]user_token\.local\.json$/);
    expect(p.startsWith("/")).toBe(true);
    if (saved !== undefined) process.env.FEISHU_USER_TOKEN_STORE = saved;
  });

  it("绝对路径原样返回", () => {
    expect(resolveTokenStorePath("/tmp/abs/token.json")).toBe("/tmp/abs/token.json");
  });
});
