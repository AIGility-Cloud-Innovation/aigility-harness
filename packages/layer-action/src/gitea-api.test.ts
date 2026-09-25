import { describe, it, expect } from "vitest";
import {
  buildGiteaUrl,
  isValidIPv4,
  readGiteaEnv,
} from "./gitea-api.js";

describe("buildGiteaUrl", () => {
  it("拼接无 query 的 URL", () => {
    expect(
      buildGiteaUrl("https://git.aigility.cloud", "/api/v1/repos/TiMEM-AI/x/issues"),
    ).toBe("https://git.aigility.cloud/api/v1/repos/TiMEM-AI/x/issues");
  });

  it("拼接 query 并做 URI 编码", () => {
    const url = buildGiteaUrl("https://git.aigility.cloud", "/api/v1/repos/TiMEM-AI/x/issues", {
      state: "open",
      limit: 20,
      q: "中文 值",
    });
    expect(url).toBe(
      "https://git.aigility.cloud/api/v1/repos/TiMEM-AI/x/issues?state=open&limit=20&q=" +
        encodeURIComponent("中文 值"),
    );
  });

  it("baseUrl 末尾斜杠归一化", () => {
    expect(buildGiteaUrl("https://git.aigility.cloud/", "/api/v1/x")).toBe(
      "https://git.aigility.cloud/api/v1/x",
    );
  });

  it("path 不以 / 开头时抛错", () => {
    expect(() => buildGiteaUrl("https://git.aigility.cloud", "api/v1/x")).toThrow();
  });
});

describe("isValidIPv4", () => {
  it("合法 IPv4 通过", () => {
    expect(isValidIPv4("43.143.234.148")).toBe(true);
    expect(isValidIPv4("0.0.0.0")).toBe(true);
    expect(isValidIPv4("255.255.255.255")).toBe(true);
  });

  it("非法输入拒绝", () => {
    expect(isValidIPv4("256.1.1.1")).toBe(false);
    expect(isValidIPv4("1.2.3")).toBe(false);
    expect(isValidIPv4("abc")).toBe(false);
    expect(isValidIPv4("")).toBe(false);
  });
});

describe("readGiteaEnv", () => {
  it("默认值为 gitea-aigility 实例固化的常量", () => {
    const saved: Record<string, string | undefined> = {
      GITEA_TOKEN: process.env.GITEA_TOKEN,
      GITEA_BASE_URL: process.env.GITEA_BASE_URL,
      GITEA_DNS_SERVER: process.env.GITEA_DNS_SERVER,
      GITEA_FALLBACK_IP: process.env.GITEA_FALLBACK_IP,
      GITEA_TOKEN_PATH: process.env.GITEA_TOKEN_PATH,
    };
    for (const k of Object.keys(saved)) delete process.env[k];
    const env = readGiteaEnv();
    expect(env.baseUrl).toBe("https://git.aigility.cloud");
    expect(env.dnsServer).toBe("223.5.5.5");
    expect(env.fallbackIp).toBe("43.143.234.148");
    expect(env.tokenPath).toContain(".gitea-token");
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  });
});
