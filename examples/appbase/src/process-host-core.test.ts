import { describe, it, expect } from "vitest";
import {
  mergeSpawnEnv,
  resolveCwd,
  isAbsolutePath,
  joinPath,
  isPidAlive,
  decideAdopt,
  classifyStatus,
  redactEnv,
  parsePluginList,
  pluginReadiness,
} from "./process-host-core.js";

describe("process-host-core spawn 环境合并", () => {
  it("继承平台全量 env (插件 env 桥产物随平台传给应用), 应用 env 同名覆盖", () => {
    const merged = mergeSpawnEnv(
      { PATH: "x", TIMEM_API_KEY: "platform-key" },
      { TIMEM_API_KEY: "app-key", EXTRA: "1" },
    );
    expect(merged.PATH).toBe("x");
    expect(merged.TIMEM_API_KEY).toBe("app-key");
    expect(merged.EXTRA).toBe("1");
  });

  it("应用 env 为空时原样继承, 不产生 undefined 值", () => {
    const merged = mergeSpawnEnv({ A: "1" }, undefined as never);
    expect(merged).toEqual({ A: "1" });
  });
});

describe("process-host-core cwd 解析", () => {
  it("相对路径相对仓库根拼接", () => {
    expect(resolveCwd("examples/apps", "C:\\repo")).toBe("C:\\repo\\examples/apps");
    expect(resolveCwd("examples/apps", "/repo")).toBe("/repo/examples/apps");
  });

  it("绝对路径原样返回, 空串回落仓库根", () => {
    expect(resolveCwd("/srv/apps", "/repo")).toBe("/srv/apps");
    expect(resolveCwd("C:\\apps", "C:\\repo")).toBe("C:\\apps");
    expect(resolveCwd("", "/repo")).toBe("/repo");
    expect(resolveCwd("  ", "/repo")).toBe("/repo");
  });

  it("绝对性判定覆盖 win32 盘符/UNC 风格与 posix 根", () => {
    expect(isAbsolutePath("C:\\x")).toBe(true);
    expect(isAbsolutePath("C:/x")).toBe(true);
    expect(isAbsolutePath("/x")).toBe(true);
    expect(isAbsolutePath("\\\\srv\\share")).toBe(true);
    expect(isAbsolutePath("examples/apps")).toBe(false);
  });

  it("joinPath 容忍根尾斜杠与子路径头斜杠", () => {
    expect(joinPath("C:\\repo\\", "\\examples")).toBe("C:\\repo\\examples");
    expect(joinPath("/repo", "examples/apps")).toBe("/repo/examples/apps");
  });
});

describe("process-host-core pid 存活", () => {
  it("当前进程视为存活, 空值/非法值不误判", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(null)).toBe(false);
  });
});

describe("process-host-core 启动决策与状态归类", () => {
  it("端口在听或 pid 存活 → 收编; 两者皆无 → 拉起", () => {
    expect(decideAdopt({ portListening: true, pidAlive: false })).toBe("adopt");
    expect(decideAdopt({ portListening: false, pidAlive: true })).toBe("adopt");
    expect(decideAdopt({ portListening: false, pidAlive: false })).toBe("spawn");
  });

  it("状态归类: 宿主持有>外部在跑>期望对齐", () => {
    expect(classifyStatus({ childAlive: true, portListening: false, pidAlive: false, desiredState: "running" })).toBe("running");
    expect(classifyStatus({ childAlive: false, portListening: true, pidAlive: false, desiredState: "running" })).toBe("adopted");
    expect(classifyStatus({ childAlive: false, portListening: false, pidAlive: true, desiredState: "running" })).toBe("adopted");
    expect(classifyStatus({ childAlive: false, portListening: false, pidAlive: false, desiredState: "running" })).toBe("exited");
    expect(classifyStatus({ childAlive: false, portListening: false, pidAlive: false, desiredState: "stopped" })).toBe("stopped");
  });
});

describe("process-host-core env 脱敏", () => {
  it("键名含 token/secret/password/key 的值打码, 其余原样", () => {
    const out = redactEnv({ LOGMON_PORT: "39467", FEISHU_TOKEN: "t", db_password: "p", apiKey: "k", HOST: "http://x" });
    expect(out.LOGMON_PORT).toBe("39467");
    expect(out.HOST).toBe("http://x");
    expect(out.FEISHU_TOKEN).toBe("••••");
    expect(out.db_password).toBe("••••");
    expect(out.apiKey).toBe("••••");
  });
});

describe("process-host-core 依赖插件清单与就绪对照", () => {
  it("数组/逗号串规整: 去空白去重保序", () => {
    expect(parsePluginList(["timem", " timem ", "feishu"])).toEqual(["timem", "feishu"]);
    expect(parsePluginList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(parsePluginList("")).toEqual([]);
  });

  it("就绪对照: 出现且无 error = mounted; 带 error / 不在表 = 未就绪", () => {
    const readiness = pluginReadiness(
      ["timem", "feishu"],
      { timem: { error: "装载失败" } },
    );
    expect(readiness).toEqual([
      { name: "timem", mounted: false, error: "装载失败" },
      { name: "feishu", mounted: false, error: undefined },
    ]);
    expect(pluginReadiness(["timem"], { timem: {} })[0].mounted).toBe(true);
  });
});
