/**
 * session-relay 单测：TranscriptStore 滚动持久化 + 中继指令路径。
 * headless 调用本身不 mock 进程（有 CLI 依赖），只测不触 CLI 的分支。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore, buildRolePatchFile, createDshSessionRelayExecute } from "./session-relay.js";

describe("TranscriptStore", () => {
  it("按 chatId 隔离并落盘 JSON", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file);
    store.push("a", "user", "你好");
    store.push("b", "user", "另一聊");
    store.push("a", "assistant", "回复");

    expect(store.get("a")).toHaveLength(2);
    expect(store.get("b")).toHaveLength(1);

    const reloaded = new TranscriptStore(file);
    expect(reloaded.get("a")).toHaveLength(2);
    expect(reloaded.get("b")).toHaveLength(1);
  });

  it("超过轮数/字符上限丢最旧，且至少保留 1 轮", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file, 3, 10_000);
    for (let i = 0; i < 6; i++) store.push("c", "user", `m${i}`);
    const turns = store.get("c");
    expect(turns).toHaveLength(3);
    expect(turns[0]?.text).toBe("m3");

    const tiny = new TranscriptStore(join(mkdtempSync(join(tmpdir(), "relay-")), "t.json"), 2, 5);
    tiny.push("d", "user", "很长很长很长很长很长的消息");
    tiny.push("d", "user", "第二条");
    expect(tiny.get("d").length).toBeGreaterThanOrEqual(1);
  });

  it("clear 删除指定聊天并持久化", () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");
    const store = new TranscriptStore(file);
    store.push("a", "user", "x");
    store.clear("a");
    expect(store.get("a")).toHaveLength(0);
    const reloaded = new TranscriptStore(file);
    expect(reloaded.get("a")).toHaveLength(0);
    expect(readFileSync(file, "utf8")).not.toContain('"a"');
  });
});

describe("createDshSessionRelayExecute 指令路径（不触 headless CLI）", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "relay-")), "t.json");

  it("/session 空历史与有历史的回复", async () => {
    const f = file();
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: f });
    expect((await execute({ user_input: "/session" })).value?.response).toContain("尚无对话历史");

    // 直接往落盘文件塞一轮（绕过 CLI），再建执行体应看到 2 轮
    const store = new TranscriptStore(f, 12, 6000);
    store.push("default", "user", "问");
    store.push("default", "assistant", "答");
    const reloaded = new TranscriptStore(f, 12, 6000);
    expect(reloaded.get("default")).toHaveLength(2);
  });

  it("/new 清空历史", async () => {
    const f = file();
    const store = new TranscriptStore(f);
    store.push("default", "user", "历史消息");
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: f });
    const r = await execute({ user_input: "/new" });
    expect(r.value?.response).toContain("已清空");
    expect(new TranscriptStore(f).get("default")).toHaveLength(0);
  });

  it("/help 列出全部指令", async () => {
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: file() });
    const r = await execute({ user_input: "/help" });
    expect(r.value?.response).toContain("/new");
    expect(r.value?.response).toContain("/session");
    expect(r.value?.response).toContain("/help");
  });

  it("未知 /命令 回提示不进模型（不触 headless）", async () => {
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: file() });
    const r = await execute({ user_input: "/deploy prod" });
    expect(r.value?.response).toContain("未知指令");
    expect(r.value?.response).toContain("/deploy");
  });

  it("指令归一化：全角／与尾随空白照常命中", async () => {
    const f = file();
    const store = new TranscriptStore(f);
    store.push("default", "user", "历史消息");
    const execute = createDshSessionRelayExecute({ dshHome: "/tmp/dsh", transcriptFile: f });
    const r = await execute({ user_input: "／new " });
    expect(r.value?.response).toContain("已清空");
    expect(new TranscriptStore(f).get("default")).toHaveLength(0);
  });
});

describe("M-A 引擎级投递：SKILL.md → AGENTS-<id>.md patch", () => {
  /** 造一个最小角色包目录树：<root>/data/roles/<id>/SKILL.md */
  const makeTree = (skillMd?: string) => {
    const root = mkdtempSync(join(tmpdir(), "m-a-"));
    const rolesDir = join(root, "data", "roles");
    mkdirSync(join(rolesDir, "sales-chat"), { recursive: true });
    if (skillMd !== undefined) writeFileSync(join(rolesDir, "sales-chat", "SKILL.md"), skillMd, "utf8");
    return { root, rolesDir };
  };
  const reg = (root: string, rolesDir: string) => ({
    skillsRoot: join(root, "skills"),
    rolesDirs: [rolesDir],
    roles: {},
    routes: {},
  });

  it("角色包有 SKILL.md → 产出 agent-instructions 单候选 patch，且正文剥除 frontmatter", () => {
    const { root, rolesDir } = makeTree(
      `---\nname: sales-chat\ndescription: 销售客服\n---\n\n你是「销售客服」，解答系统使用问题后委托 L4。\n`,
    );
    const out = join(root, "patch", "patch-sales-chat.yml");
    const ret = buildRolePatchFile(reg(root, rolesDir), { id: "sales-chat", config: {} }, out);
    expect(ret).toBe(out);
    // 快照文件只含正文（frontmatter 不污染 system prompt）
    const snapshot = readFileSync(join(root, "patch", "AGENTS-sales-chat.md"), "utf8");
    expect(snapshot).toBe("你是「销售客服」，解答系统使用问题后委托 L4。\n");
    expect(snapshot).not.toContain("description:");
    // patch 覆盖 agent-instructions，候选表收窄为【纯文件名】（DSH 语义：相对各祖先目录查找，
    // 含 / 的候选会被 resolveInstructionFileCandidates 静默丢弃 → 人设零注入）
    const yml = readFileSync(out, "utf8");
    expect(yml).toContain(`id: "agent-instructions"`);
    expect(yml).toContain(`- ${JSON.stringify("AGENTS-sales-chat.md")}`);
    expect(yml).not.toMatch(/instructionFileCandidates:[\s\S]*AGENTS-sales-chat\.md[^\n]*\//);
    expect(yml).toContain("maxBytes: 65536");
  });

  it("传入 cwd → 快照落到会话 cwd（DSH 在 cwd 按文件名扫描候选）", () => {
    const { root, rolesDir } = makeTree(
      `---\nname: sales-chat\n---\n\n你是「销售客服」。\n`,
    );
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const out = join(root, "patch", "patch-sales-chat.yml");
    buildRolePatchFile(reg(root, rolesDir), { id: "sales-chat", config: {} }, out, ws);
    expect(readFileSync(join(ws, "AGENTS-sales-chat.md"), "utf8")).toBe("你是「销售客服」。\n");
    const yml = readFileSync(out, "utf8");
    expect(yml).toContain(`- ${JSON.stringify("AGENTS-sales-chat.md")}`);
  });

  it("角色包缺失/正文为空 → 不出该分支（零开销，不产文件）", () => {
    const { root, rolesDir } = makeTree(); // 无 SKILL.md
    const out = join(root, "patch", "patch-sales-chat.yml");
    expect(buildRolePatchFile(reg(root, rolesDir), { id: "sales-chat", config: {} }, out)).toBeNull();
    const { root: r2, rolesDir: d2 } = makeTree(`---\nname: sales-chat\n---\n\n   \n`);
    expect(buildRolePatchFile(reg(r2, d2), { id: "sales-chat", config: {} }, join(r2, "p.yml"))).toBeNull();
  });

  it("default 角色不走角色包解析（无专属人设）", () => {
    const { root, rolesDir } = makeTree(`---\nname: sales-chat\n---\n\n正文\n`);
    mkdirSync(join(rolesDir, "default"), { recursive: true });
    writeFileSync(join(rolesDir, "default", "SKILL.md"), `---\nname: default\n---\n\n不该被注入\n`, "utf8");
    expect(buildRolePatchFile(reg(root, rolesDir), { id: "default", config: {} }, join(root, "p.yml"))).toBeNull();
  });

  it("显式 instructionsFile 优先于角色包，且原样快照（逃生舱保留）", () => {
    const { root, rolesDir } = makeTree(`---\nname: sales-chat\n---\n\n角色包正文\n`);
    const custom = join(root, "custom-persona.md");
    writeFileSync(custom, "手工指定的正文", "utf8");
    const out = join(root, "patch", "patch-sales-chat.yml");
    buildRolePatchFile(reg(root, rolesDir), { id: "sales-chat", config: { instructionsFile: custom } }, out);
    expect(readFileSync(join(root, "patch", "AGENTS-sales-chat.md"), "utf8")).toBe("手工指定的正文");
  });
});
