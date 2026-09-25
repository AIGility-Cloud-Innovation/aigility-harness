import { describe, it, expect } from "vitest";
import {
  buildFeishuUrl,
  buildAuthorizeUrl,
  isTokenExpired,
  extractAuthCode,
  readTokenEnv,
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

describe("buildAuthorizeUrl", () => {
  it("默认参数生成标准授权链接（回调/scope 走约定默认，state 自动生成）", () => {
    const a = buildAuthorizeUrl({ appId: "cli_a123" });
    expect(a.redirectUri).toBe("http://localhost:18080/callback");
    expect(a.scopes).toBe("task:task:read task:task:write");
    expect(a.state).toMatch(/^[0-9a-f]{32}$/);
    expect(a.url).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize" +
        `?app_id=cli_a123` +
        `&redirect_uri=${encodeURIComponent("http://localhost:18080/callback")}` +
        `&scope=${encodeURIComponent("task:task:read task:task:write")}` +
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
  it("缺省 token store 路径为 feishu/user_token.local.json", () => {
    const saved = process.env.FEISHU_USER_TOKEN_STORE;
    delete process.env.FEISHU_USER_TOKEN_STORE;
    expect(readTokenEnv().tokenStorePath).toBe("feishu/user_token.local.json");
    if (saved !== undefined) process.env.FEISHU_USER_TOKEN_STORE = saved;
  });
});
