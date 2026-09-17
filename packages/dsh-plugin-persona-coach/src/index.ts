/**
 * @aigility-harness/dsh-plugin-persona-coach — 官方 dsh 生态的第一个角色插件
 * (M2③, docs/dsh-生态共建规划.md §四)。
 *
 * 把 AppBase 的 @persona/coding-coach（编码教练：分步引导设计一个案例应用，
 * 只引导、不真正生成/保存任何文件，最终产出可直接交给「网页应用开发员」的
 * 完整提示词）做成官方 dsh 可装载的 cordis 插件：
 *   - `systemPrompt.section` 注入角色形象与五阶段引导法——阶段定义逐字对齐
 *     AppBase 内 @orchestration/guided-design，保证行为一致；
 *   - `commands.register` 注册 /coach 命令，直接返回引导说明。
 *
 * 打包规范（规划 §四）：
 *   - 导出 apply + name (+ inject)，cordis 约定，与官方插件一致；
 *   - peerDependencies 只声明 cordis + 所依赖的 dsh 服务包，不打包 dsh 本体；
 *   - 清单/配置纯数据，不用 `!!js`。
 *
 * 类型策略：只对官方服务面取窄的结构视图（对齐 0.1.5-rc.2 拆包实测 API），
 * 不 import 官方类型——生态包发布后不把官方类型树拖进 peer 类型解析。
 */

/** 官方 dsh-system-prompt 服务面（本插件用到的窄切面） */
interface SystemPromptView {
  section(section: { name: string; order: number; text: string }): () => void;
}

/** 官方 CommandResult（types.d.ts 实测：success/error 文本两态） */
type CommandResultView =
  | { kind: "success"; text?: string }
  | { kind: "error"; text: string };

/** 官方 dsh-commands 服务面（本插件用到的窄切面） */
interface CommandsView {
  register(definition: {
    name: string;
    description: string;
    handler: (invocation: { rawInput: string }) => CommandResultView;
  }): () => void;
}

/** cordis inject 注入后的调用面：两个服务都已就绪 */
interface PluginContext {
  systemPrompt: SystemPromptView;
  commands: CommandsView;
}

export interface PersonaCoachConfig {
  /** 角色文本覆盖（默认内置编码教练形象，已对齐 AppBase 行为） */
  personaText?: string;
  /** slash 命令名（默认 "coach"，小写不带斜杠） */
  commandName?: string;
  /** 角色 section 排序键（默认 0 = 官方 DEPLOYMENT_PERSONA_PREFIX 层） */
  sectionOrder?: number;
}

/** 五阶段引导法——逐字对齐 AppBase @orchestration/guided-design 的 DESIGN_PHASES */
export const DESIGN_PHASES: ReadonlyArray<{ title: string; collect: string }> = [
  {
    title: "需求理解",
    collect:
      "这个应用给谁用(角色/场景)? 要解决的核心问题是什么? 最重要的那一件事是什么?",
  },
  {
    title: "功能清单",
    collect:
      "必备功能有哪些(按优先级排列, 先核心后锦上添花)? 第一版明确不做什么?",
  },
  {
    title: "页面与数据",
    collect:
      "需要哪几个页面/视图, 各展示什么? 有哪些数据实体和字段(如 学生:姓名/学号/积分)? 数据存本地还是云端?",
  },
  {
    title: "交互与边界",
    collect:
      "关键操作流程是怎样的(怎么录入/查看/统计)? 边界情况(空数据/录错了怎么办)? 需要多设备同步吗?",
  },
  {
    title: "确认与出提示词",
    collect: "向用户逐条汇总前面收集到的全部结论, 请用户确认或补充修改",
  },
];

/** 默认角色文本——与 AppBase 内编码教练形象一致（角色名永不含实现名） */
export const DEFAULT_PERSONA_TEXT = `你是「编码教练」。你的唯一任务：一步步引导用户把一个应用想法设计清楚。

铁律：
- 只引导与提问，绝不真正生成、写入或保存任何文件；代码在阶段五之前一律不写。
- 每轮只推进当前阶段：先简短提炼确认用户上一轮的输入，再提出当前阶段的问题要点；不要一次性问完所有阶段。
- 用户跑偏时温和拉回当前阶段；用户明确说"跳过"时记录并进入下一阶段。

五阶段（每阶段要收集清楚的要点）：
${DESIGN_PHASES.map((p, i) => `${i + 1}. ${p.title}：${p.collect}`).join("\n")}

阶段五确认完成后，产出一份完整、可直接交给「网页应用开发员」执行的开发提示词：
自包含（含全部已确认的需求/功能/页面/数据/交互/边界结论）、无占位、可直接开工。
产出提示词前先向用户说明"以下是可以交给开发员的完整提示词"。`;

/** /coach 命令的引导说明（命令结果由 UI 直接渲染，不经模型） */
export const COACH_COMMAND_TEXT = [
  "编码教练已就位。把你的应用想法直接发给 agent（一句话即可，如「我想给班里做个记账本」），",
  "我会按五个阶段引导你把设计聊清楚：",
  ...DESIGN_PHASES.map((p, i) => `  ${i + 1}. ${p.title}`),
  "全程只引导不写代码；聊完产出一份可直接交给开发员的完整提示词。",
  "随时输入 /coach 可再看本说明。",
].join("\n");

/** cordis 插件名（官方行装载按此识别） */
export const name = "persona-coach";

/** 依赖的官方服务：cordis 保证 apply 前已装载并可经 ctx 访问 */
export const inject = ["systemPrompt", "commands"];

/**
 * 插件装载：注册角色 section + /coach 命令；返回合并 disposer（cordis 约定）。
 */
export function apply(
  ctx: PluginContext,
  config: PersonaCoachConfig = {},
): () => void {
  const personaText =
    config.personaText && config.personaText.trim().length > 0
      ? config.personaText
      : DEFAULT_PERSONA_TEXT;
  const commandName = config.commandName ?? "coach";

  const disposeSection = ctx.systemPrompt.section({
    name: "persona-coach",
    order: config.sectionOrder ?? 0,
    text: personaText,
  });
  const disposeCommand = ctx.commands.register({
    name: commandName,
    description:
      "编码教练：分步引导设计一个案例应用（不落盘），最终产出完整开发提示词",
    handler: () => ({ kind: "success", text: COACH_COMMAND_TEXT }),
  });
  return () => {
    disposeCommand();
    disposeSection();
  };
}
