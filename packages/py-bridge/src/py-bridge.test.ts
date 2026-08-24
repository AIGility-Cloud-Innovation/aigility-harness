/**
 * py-bridge 端到端测试 — spawn 真实 Python worker, 验证完整通信链路.
 *
 * 测试用 Python 标准库函数, 不依赖 aigility 或任何第三方包。
 */

import { describe, it, expect, afterAll } from "vitest";
import { PyWorker } from "./py-worker.js";

// 用 Python 内置函数测试, 不需要任何第三方包
// Python: json.loads('{"a":1}') → {"a": 1}
// 我们通过 worker 调 json.loads

describe("PyWorker 端到端", () => {
  const worker = new PyWorker({ pythonExecutable: "python3" });

  afterAll(async () => {
    await worker.dispose();
  });

  it("启动并发送 ready 通知", async () => {
    const result = await worker.start();
    expect(result.ok).toBe(true);
  });

  it("initialize + call 同步函数", async () => {
    // 用 Python 内置 json.loads 做测试
    // function = "json.loads", 它是一个函数, 不是类
    const initResult = await worker.initialize("test-json-loads", {
      function: "json.loads",
    });
    expect(initResult.ok).toBe(true);

    const callResult = await worker.call("test-json-loads", {
      s: '{"hello": "world", "num": 42}',
    });
    expect(callResult.ok).toBe(true);
    expect(callResult.value).toEqual({ hello: "world", num: 42 });
  });

  it("initialize + call 实例方法", async () => {
    // 用 Python collections.OrderedList 做测试 — 不行, 没有这个
    // 用 os.PathLike 不行...
    // 用一个简单的: str.format 是实例方法
    // "hello {}".format("world") → "hello world"
    // 但 str 构造需要位置参数, init 用 {"object": "hello {}"} 不行 (str 不接受 kwargs)
    // 用 list.append? 不行, append 不返回值
    // 用 dict.copy — dict(key="value").copy() → {"key": "value"}
    const initResult = await worker.initialize("test-dict-copy", {
      function: "dict",
      method: "copy",
      init: { "key": "value" },  // dict(key="value")
    });
    expect(initResult.ok).toBe(true);

    const callResult = await worker.call("test-dict-copy", {});
    expect(callResult.ok).toBe(true);
    if (callResult.ok) {
      expect(callResult.value).toEqual({ key: "value" });
    }
  });

  it("幂等 initialize (重复调用不报错)", async () => {
    const r1 = await worker.initialize("test-idempotent", {
      function: "json.loads",
    });
    const r2 = await worker.initialize("test-idempotent", {
      function: "json.loads",
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("批量调用 callBatch", async () => {
    // 先确保有已初始化的 capability
    await worker.initialize("test-batch", {
      function: "json.loads",
    });

    const result = await worker.callBatch([
      { capId: "test-batch", kwargs: { s: '{"a": 1}' } },
      { capId: "test-batch", kwargs: { s: '{"b": 2}' } },
      { capId: "test-batch", kwargs: { s: '{"c": 3}' } },
    ]);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ]);
  });

  it("健康检查", async () => {
    const h = await worker.health();
    expect(h.healthy).toBe(true);
    expect(h.capabilities.length).toBeGreaterThanOrEqual(1);
  });

  it("未初始化的 capability 报错", async () => {
    const result = await worker.call("nonexistent-cap", {});
    expect(result.ok).toBe(false);
  });
});
