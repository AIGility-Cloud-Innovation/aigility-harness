import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskRegistry, isWrongRepoDelivery } from "@aigility-harness/layer-orchestration";
import { syncPrDeliveredTasks } from "./pr-board-sync.js";

const wrongPrUrl = "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/pulls/271";
const samePrUrl = "https://git.aigility.cloud/TiMEM-AI/timem-platform-backend/pulls/272";
const feishuCall = async () => {
  throw new Error("PR consistency guard must not touch Feishu");
};

let projectionFile: string;

beforeEach(() => {
  projectionFile = join(mkdtempSync(join(tmpdir(), "pr-board-sync-")), "projection.json");
  writeFileSync(projectionFile, "{}");
  process.env["BOARD_PROJECTION_FILE"] = projectionFile;
});

afterEach(() => {
  delete process.env["BOARD_PROJECTION_FILE"];
});

function seedReview(title: string, note: string): TaskRegistry {
  const registry = new TaskRegistry(undefined);
  const record = registry.adopt({
    description: "PR 交付回归",
    origin: { provider: "unit-test", guid: `${title}:${note}` },
    title,
    links: { "feishu-task": { guid: "task-guid" } },
  } as never);
  registry.update(record.uid, { note }); // adopt 不落 note，走复核补齐通道
  registry.transition(record.uid, "review", "planned");
  return registry;
}

describe("pr-board-sync 仓库一致性保险", () => {
  it("错仓 review → 保持 failed，不挪卡、不读任务、不补 PR", async () => {
    expect(isWrongRepoDelivery("【timem_console_frontend】修复页面", wrongPrUrl)).toBe(true);
    const registry = seedReview("【timem_console_frontend】修复页面", `[worker-team/codex] 交付 ${wrongPrUrl}`);
    await expect(syncPrDeliveredTasks(registry, feishuCall)).resolves.toEqual([]);
    expect(registry.list({ status: ["review"] })).toEqual([]);
    expect(registry.list({ status: ["failed"] })).toHaveLength(1);
    expect(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(projectionFile, "utf8")))).toEqual({});
  });

  it("历史交付失败的错仓记录不会被再次挪卡", async () => {
    const registry = seedReview(
      "【timem_console_frontend】修复页面",
      `[worker-team/codex] 交付失败：错仓：PR 在 TiMEM-AI/timem-platform-backend，卡归属 timem_console_frontend（${wrongPrUrl}）`,
    );
    registry.transition(registry.list({ status: ["review"] })[0]!.uid, "failed", "review");

    await expect(syncPrDeliveredTasks(registry, feishuCall)).resolves.toEqual([]);
    expect(registry.list({ status: ["review"] })).toEqual([]);
    expect(registry.list({ status: ["failed"] })).toHaveLength(1);
    expect(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(projectionFile, "utf8")))).toEqual({});
  });

  it("同仓 review 走原有 C 挪卡动作", async () => {
    expect(isWrongRepoDelivery("【timem-platform-backend】修复接口", samePrUrl)).toBe(false);
    const registry = seedReview("【timem-platform-backend】修复接口", `[worker-team/codex] 交付 ${samePrUrl}`);
    // 同仓不触发保险：走到挪卡阶段读 feishu-task（守卫 mock 抛错被逐任务吞掉，返回空数组）
    const moved = await syncPrDeliveredTasks(registry, feishuCall);
    expect(moved).toEqual([]);
    expect(registry.list({ status: ["review"] })).toHaveLength(1); // 未挪成，仍留 review
    expect(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(projectionFile, "utf8")))).toEqual({});
  });
});
