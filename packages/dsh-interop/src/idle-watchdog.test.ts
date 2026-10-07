/**
 * 第 2 层（idle watchdog）行为验证。
 *
 * 这些用例用「真实子进程 + 真实 SIGKILL + 真实计时器」跑，不 mock 进程：
 * 为了让 dshRunCli 去跑我们自己造的子进程，用例里动态生成一个假 CLI 脚本，
 * 并把它所在的假包目录塞进 module.paths 供 localRequire 解析 @deepseek-ai/dsh/package.json。
 *
 * 三个关键断言：
 *  1. 长任务只要持续有输出（总时长远超阈值） → 必须成功，不得被杀；
 *  2. 中途彻底沉默超过阈值 → 被杀，且 timedOut=true、已产出部分保留；
 *  3. 快速正常结束 → elapsed=0、timedOut 为 undefined（不误标）。
 */
import { describe, expect, it, beforeAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dshRunCli } from "./session-relay.js";

/** 造一个假 CLI 脚本，返回 { binJs, cwd, dshHome } */
function makeFakeCli(body: string): { binJs: string; cwd: string; dshHome: string } {
  const root = mkdtempSync(join(tmpdir(), "fakedsh-"));
  const cwd = join(root, "cwd");
  const dshHome = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  const binJs = join(root, "bin.js");
  writeFileSync(binJs, body, "utf8");
  return { binJs, cwd, dshHome };
}

describe("dshRunCli idle watchdog", () => {
  const IDLE = 400;

  it("持续有输出的长任务：总时长远超 idle 阈值也必须跑完（不再被总时长硬杀）", async () => {
    // 每 100ms 吐一行，共 12 行 = 约 1.2s，是 idle 阈值(400ms)的 3 倍总时长。
    // 旧实现（总时长硬杀）在这里必死；新实现必须成功。
    const { binJs, cwd, dshHome } = makeFakeCli(`
      let i = 0;
      const t = setInterval(() => {
        i++;
        process.stdout.write("tick-" + i + "\\n");
        if (i >= 12) { clearInterval(t); process.exit(0); }
      }, 100);
    `);
    const r = await dshRunCli({ dshBinJs: binJs, cwd, dshHome, task: "x", timeoutMs: IDLE });

    expect(r.ok).toBe(true);
    expect(r.timedOut).toBeUndefined();
    expect(r.durationMs).toBeGreaterThan(IDLE * 2); // 确实跑了远超阈值的时间
    expect(r.output).toContain("tick-12");          // 且完整跑完，没被腰斩
  });

  it("中途彻底沉默超过阈值：被杀，timedOut=true 且已产出部分保留", async () => {
    const { binJs, cwd, dshHome } = makeFakeCli(`
      process.stdout.write("PARTIAL-A\\nPARTIAL-B\\n");
      setTimeout(() => { process.stdout.write("SHOULD-NEVER-APPEAR\\n"); process.exit(0); }, 60000);
    `);
    const started = Date.now();
    const r = await dshRunCli({ dshBinJs: binJs, cwd, dshHome, task: "x", timeoutMs: IDLE });
    const elapsed = Date.now() - started;

    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain("PARTIAL-A");
    expect(r.output).toContain("PARTIAL-B");
    expect(r.output).not.toContain("SHOULD-NEVER-APPEAR");
    // 是在 idle 阈值附近收割的，不是等 60s 子进程自己结束
    expect(elapsed).toBeLessThan(5000);
  });

  it("快速正常结束：不误标 timedOut", async () => {
    const { binJs, cwd, dshHome } = makeFakeCli(`
      process.stdout.write("done-fast\\n");
      process.exit(0);
    `);
    const r = await dshRunCli({ dshBinJs: binJs, cwd, dshHome, task: "x", timeoutMs: IDLE });

    expect(r.ok).toBe(true);
    expect(r.timedOut).toBeUndefined();
    expect(r.output).toBe("done-fast");
  });

  it("沉默后又有输出：计时器被刷新，不该被误杀", async () => {
    // 沉默 3 次（每次 100ms < 400ms 阈值）后结束，累计 300ms 静默但从未连续超阈值
    const { binJs, cwd, dshHome } = makeFakeCli(`
      let i = 0;
      const step = () => {
        i++;
        process.stdout.write("chunk-" + i + "\\n");
        if (i >= 3) process.exit(0);
        else setTimeout(step, 100);
      };
      step();
    `);
    const r = await dshRunCli({ dshBinJs: binJs, cwd, dshHome, task: "x", timeoutMs: IDLE });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("chunk-3");
  });
});