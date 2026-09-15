import { describe, it, expect } from "vitest";
import {
  apply,
  name,
  inject,
  DEFAULT_PERSONA_TEXT,
  DESIGN_PHASES,
  COACH_COMMAND_TEXT,
  type PersonaCoachConfig,
} from "./index.js";

/** 记录式桩：模仿官方 systemPrompt / commands 服务面 */
function makeStubCtx() {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const commands: Array<{
    name: string;
    description: string;
    handler: (inv: { rawInput: string }) => unknown;
  }> = [];
  const disposed: string[] = [];
  const ctx = {
    systemPrompt: {
      section(s: { name: string; order: number; text: string }) {
        sections.push(s);
        return () => disposed.push(`section:${s.name}`);
      },
    },
    commands: {
      register(d: {
        name: string;
        description: string;
        handler: (inv: { rawInput: string }) => unknown;
      }) {
        commands.push(d);
        return () => disposed.push(`command:${d.name}`);
      },
    },
  };
  return { ctx, sections, commands, disposed };
}

describe("dsh-plugin-persona-coach — cordis 插件约定", () => {
  it("导出 apply + name + inject（官方插件形态）", () => {
    expect(typeof apply).toBe("function");
    expect(name).toBe("persona-coach");
    expect(inject).toEqual(["systemPrompt", "commands"]);
  });

  it("apply: 注册角色 section（order 0）与 /coach 命令", () => {
    const { ctx, sections, commands } = makeStubCtx();
    apply(ctx);
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe("persona-coach");
    expect(sections[0].order).toBe(0);
    // 五阶段与 AppBase guided-design 逐字一致
    for (const p of DESIGN_PHASES) {
      expect(sections[0].text).toContain(p.title);
      expect(sections[0].text).toContain(p.collect);
    }
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe("coach");
    const result = commands[0].handler({ rawInput: "" }) as {
      kind: string;
      text?: string;
    };
    expect(result.kind).toBe("success");
    expect(result.text).toContain("编码教练");
  });

  it("apply: 配置可覆盖角色文本/命令名/排序", () => {
    const { ctx, sections, commands } = makeStubCtx();
    const cfg: PersonaCoachConfig = {
      personaText: "自定义角色",
      commandName: "guide",
      sectionOrder: 42,
    };
    apply(ctx, cfg);
    expect(sections[0].text).toBe("自定义角色");
    expect(sections[0].order).toBe(42);
    expect(commands[0].name).toBe("guide");
  });

  it("空白 personaText 回退默认角色文本", () => {
    const { ctx, sections } = makeStubCtx();
    apply(ctx, { personaText: "   " });
    expect(sections[0].text).toBe(DEFAULT_PERSONA_TEXT);
  });

  it("disposer: 注销 section 与命令", () => {
    const { ctx, disposed } = makeStubCtx();
    const dispose = apply(ctx);
    dispose();
    expect(disposed).toEqual(["command:coach", "section:persona-coach"]);
  });

  it("默认产出承诺: 只引导不落盘 + 最终交给网页应用开发员", () => {
    expect(DEFAULT_PERSONA_TEXT).toContain("绝不真正生成、写入或保存任何文件");
    expect(DEFAULT_PERSONA_TEXT).toContain("网页应用开发员");
    expect(COACH_COMMAND_TEXT).toContain("五个阶段");
  });
});
