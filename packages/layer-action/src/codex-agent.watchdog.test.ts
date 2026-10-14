/**
 * codex-agent 静默看门狗（idle watchdog）+ 环境净化 行为验证。
 *
 * 用「真实子进程 + 真实 SIGTERM + 真实计时器」跑，不 mock：
 *  1. 持续有输出的长任务（总时长远超阈值）→ 必须成功，不得被误杀；
 *  2. 中途彻底沉默超过阈值 → 必须被杀，错误信息含 stalled + 静默时长；
 *  3. 快速正常结束 → 不误判；
 *  4. silentTimeoutMs <= 0 → 关闭看门狗，沉默任务靠整体超时兜底；
 *  5. 环境净化：PYTHONPATH / VIRTUAL_ENV 等不得泄漏给子进程。
 *
 * 技巧：用 CODEX_BIN 指向自造的假 codex 脚本（.mjs，Node 可直接执行），
 * 让它按 codex 的 JSONL 事件协议输出。
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { codexAgentProvider } from "./codex-agent.js";

/** 造一个假 codex 可执行脚本（.mjs），返回其绝对路径 */
function makeFakeCodex(jsBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fakecodex-"));
  const bin = join(dir, "fake-codex.mjs");
  // 必须带 shebang：spawn 走 execve，没有 shebang 会被当 sh 脚本解析而语法报错。
  // 用 process.execPath 的绝对路径而非 `env node`，避免用例里 PATH 被改造后找不到 node。
  // 前置一句「消费 stdin」：真实 codex 会读 prompt，假脚本不读会让 agent 的
  // stdin.write 撞上已关闭管道抛 EPIPE。
  const preamble = `process.stdin.resume(); process.stdin.on("data", () => {}); process.stdin.on("error", () => {});\n`;
  writeFileSync(bin, `#!${process.execPath}\n${preamble}${jsBody}`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

/** codex JSONL 事件行：agent_message 的载荷放在 payload 里 */
const msgLine = (text: string): string =>
  `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(
    text,
  )} } }));`;

/** 造一个最小 ctx（跳过认知层规划） */
function makeCtx(): { ctx: any; events: any[] } {
  const events: any[] = [];
  const ctx = {
    traceId: "test-trace",
    emit: (e: any) => events.push(e),
    call: async () => {
      throw new Error("test ctx: call() 不应被调用（用例均设 skipPlanning=true）");
    },
  };
  return { ctx, events };
}

const baseReq = (over: Record<string, unknown> = {}) => ({
  prompt: "test task",
  skipPlanning: true,
  sanitizeEnv: false,
  ...over,
});

describe("codex-agent idle watchdog", () => {
  it("持续有输出的长任务：总时长远超 idle 阈值也必须跑完（不被误杀）", async () => {
    const IDLE = 500;
    // 每 120ms 吐一行，共 12 行 ≈ 1.44s，是 idle 阈值(500ms)的近 3 倍总时长
    const bin = makeFakeCodex(`
      let i = 0;
      const t = setInterval(() => {
        i++;
        ${msgLine("PLACEHOLDER")}
        if (i >= 12) { clearInterval(t); process.exit(0); }
      }, 120);
    `.replace('"PLACEHOLDER"', '"tick " + i'));
    process.env.CODEX_BIN = bin;

    const { ctx } = makeCtx();
    const res = await codexAgentProvider.execute(
      baseReq({ silentTimeoutMs: IDLE, timeoutMs: 30_000 }) as any,
      ctx as any,
    );

    if (!res.ok) console.error("WATCHDOG_TEST_DEBUG:", res.error);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toContain("tick 12");
  }, 20_000);

  it("中途彻底沉默超过阈值 → 被杀，错误含 stalled 与静默时长", async () => {
    const IDLE = 600;
    const bin = makeFakeCodex(`
      ${msgLine("started")}
      setTimeout(() => {}, 60_000);
    `);
    process.env.CODEX_BIN = bin;

    const { ctx } = makeCtx();
    const t0 = Date.now();
    const res = await codexAgentProvider.execute(
      baseReq({ silentTimeoutMs: IDLE, timeoutMs: 60_000 }) as any,
      ctx as any,
    );
    const elapsed = Date.now() - t0;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("stalled");
      expect(res.error).toMatch(/no stdout activity for/i);
    }
    // 必须在 idle 阈值附近就被收割，而不是耗到 60s 整体超时
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it("快速正常结束 → 不被误判为卡死", async () => {
    const bin = makeFakeCodex(`
      ${msgLine("done quickly")}
      process.exit(0);
    `);
    process.env.CODEX_BIN = bin;

    const { ctx } = makeCtx();
    const res = await codexAgentProvider.execute(
      baseReq({ silentTimeoutMs: 5_000, timeoutMs: 30_000 }) as any,
      ctx as any,
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toContain("done quickly");
  }, 20_000);

  it("silentTimeoutMs <= 0 关闭看门狗：沉默任务不被 idle 杀", async () => {
    const bin = makeFakeCodex(`
      ${msgLine("silent then done")}
      setTimeout(() => process.exit(0), 1500);
    `);
    process.env.CODEX_BIN = bin;

    const { ctx } = makeCtx();
    const res = await codexAgentProvider.execute(
      baseReq({ silentTimeoutMs: 0, timeoutMs: 30_000 }) as any,
      ctx as any,
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toContain("silent then done");
  }, 20_000);
});

describe("codex-agent env sanitize", () => {
  it("PYTHONPATH / VIRTUAL_ENV 等不得泄漏给子进程", () => {
    // 真实验证：在带污染环境变量的进程里跑一次 codex-agent（sanitizeEnv=true），
    // 假 codex 把看到的环境打印出来。
    const bin = makeFakeCodex(`
      console.log(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify({
          PYTHONPATH: process.env.PYTHONPATH ?? null,
          VIRTUAL_ENV: process.env.VIRTUAL_ENV ?? null,
          PYTHONHOME: process.env.PYTHONHOME ?? null,
          PATH_HAS_HERMES_VENV: /hermes\\/installs\\/.*\\/venv\\/bin/.test(process.env.PATH ?? ""),
        }) },
      }));
      process.exit(0);
    `);

    const agentUrl = new URL("./codex-agent.js", import.meta.url).pathname;
    const probe = `
      process.env.CODEX_BIN = ${JSON.stringify(bin)};
      process.env.PYTHONPATH = "/polluted/3.14/site-packages";
      process.env.VIRTUAL_ENV = "/polluted/venv";
      process.env.PYTHONHOME = "/polluted/home";
      process.env.PATH = "/polluted/.hermes/installs/python314/venv/bin:/usr/bin:/bin";
      const { codexAgentProvider } = await import(${JSON.stringify(agentUrl)});
      const ctx = { traceId: "t", emit: () => {}, call: async () => { throw new Error("no"); } };
      const res = await codexAgentProvider.execute(
        { prompt: "probe", skipPlanning: true, sanitizeEnv: true, silentTimeoutMs: 5000, timeoutMs: 20000 },
        ctx,
      );
      console.log("PROBE_RESULT " + JSON.stringify({ ok: res.ok, text: res.ok ? res.value.text : res.error }));
    `;
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const probeFile = join(dir, "probe.mjs");
    writeFileSync(probeFile, probe);

    const r = spawnSync("npx", ["tsx", probeFile], {
      encoding: "utf8",
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env },
      timeout: 60_000,
    });

    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // 假 codex 把子进程环境以 JSON 字符串返回，agent 再包一层 JSON 输出，
    // 所以断言前先反转义，避免被 \\\" 形式骗过。
    const unescaped = out.replace(/\\"/g, '"');
    // 净化后子进程环境里不应出现污染值
    expect(unescaped).not.toContain("/polluted/3.14/site-packages");
    expect(unescaped).not.toContain("/polluted/venv");
    expect(unescaped).not.toContain("/polluted/home");
    expect(unescaped).toContain('"PYTHONPATH":null');
    expect(unescaped).toContain('"VIRTUAL_ENV":null');
    expect(unescaped).toContain('"PYTHONHOME":null');
    expect(unescaped).toContain('"PATH_HAS_HERMES_VENV":false');
  }, 90_000);
});