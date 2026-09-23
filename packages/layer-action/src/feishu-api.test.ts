import { describe, it, expect } from "vitest";
import {
  buildFeishuUrl,
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
