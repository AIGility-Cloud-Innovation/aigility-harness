/**
 * team-memory-console CLI — 团队记忆花名册与查询命令行
 *
 * 环境变量: TIMEM_API_KEY (必填, 查询/探测类命令), TIMEM_BASE_URL (可选)
 *
 * 命令:
 *   list                          列出花名册 (成员 → user_id 绑定)
 *   who <姓名|别名|user_id>       反查/正查对齐关系
 *   add  <member_id> <姓名> [别名,别名...]         新增成员
 *   bind <member_id> <user_id>    绑定太忆云 user_id (绑定前自动 probe)
 *   unbind <member_id> <user_id>  解绑
 *   rm <member_id>                删除成员
 *   query <成员|all> <问题...>    查某成员(或全员)的团队记忆, 结果标注归属人
 *   probe <user_id>               探测云端该 user_id 是否有记忆
 *   unknown                       (query 过程中) 观察到的未登记 user_id
 *
 * 示例:
 *   pnpm --filter team-memory-console cli list
 *   pnpm --filter team-memory-console cli query 张三 最近部署遇到什么问题
 */

import { readFileSync, existsSync } from "node:fs";
import { TeamRegistry } from "./registry.js";
import { TeamMemoryService } from "./service.js";
import { buildDayReport, buildDayPlan, resolveDate } from "./report.js";
import { buildCompactDailyReport, buildCompactMorningReport, buildDailyBriefing, buildMorningBriefing, loadRegistryTasks } from "./task-cards.js";
import { resolveSummarizeConfig, callLlm } from "./summarize.js";
import { sendGroupTextChunked, DEFAULT_REPORT_CHAT_ID } from "./feishu.js";

const REGISTRY_PATH = new URL("../../../config/timem-team-registry.json", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

/** 定时任务友好: 自动加载仓库根 .env 与 examples/.dsh-home/.env (不覆盖已有变量) */
function loadEnvFiles(): void {
  for (const p of [new URL("../../../.env", import.meta.url), new URL("../../.dsh-home/.env", import.meta.url)]) {
    const path = decodeURIComponent(p.pathname).replace(/^\/(\w:)/, "$1");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      const eq = t.indexOf("=");
      if (!t || t.startsWith("#") || eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
    }
  }
}
loadEnvFiles();

function makeService(): TeamMemoryService {
  const apiKey = process.env.TIMEM_API_KEY ?? "";
  if (!apiKey) {
    console.error("缺少 TIMEM_API_KEY 环境变量 (太忆云 API Key)");
    process.exit(1);
  }
  return new TeamMemoryService({ apiKey, baseUrl: process.env.TIMEM_BASE_URL, registryPath: REGISTRY_PATH });
}

function printMemberLine(indent: string, m: import("./registry.js").TeamMember): void {
  console.log(`${indent}${m.name} (${m.member_id})${m.role ? ` — ${m.role}` : ""}`);
  console.log(`${indent}  别名: ${(m.aliases ?? []).join(", ") || "无"}`);
  console.log(`${indent}  user_id: ${m.timem_user_ids.length ? m.timem_user_ids.join(", ") : "⚠ 未绑定"}`);
}

/**
 * 采集健康度统计行（stderr）：平台调度器解析进 runs.stats（为后续 RSI 自检留数）。
 * status=ok 但 memories=0 = 采集侧静默失败的信号（"空壳正常"报告）。
 */
function printJobStats(kind: string, members: Array<{ member: { name: string }; memories: unknown[] }>): void {
  try {
    const stats = {
      kind,
      members: members.filter((m) => m.memories.length).length,
      memories: members.reduce((n, m) => n + m.memories.length, 0),
      tasks: loadRegistryTasks().filter((t) => t.status !== "cancelled").length,
    };
    console.error(`[job-stats] ${JSON.stringify(stats)}`);
  } catch {
    // 统计失败不影响主流程
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;

  const reg = new TeamRegistry(REGISTRY_PATH);

  switch (cmd) {
    case "list": {
      console.log(`花名册共 ${reg.members.length} 人:\n`);
      for (const m of reg.members) printMemberLine("  ", m);
      break;
    }
    case "who": {
      const ref = args[0];
      if (!ref) throw new Error("用法: who <姓名|别名|user_id>");
      if (reg.isKnownUserId(ref)) {
        const m = reg.findByUserId(ref)!;
        console.log(`user_id ${ref} → ${m.name} (${m.member_id})`);
      } else {
        const r = reg.resolve(ref);
        if (r.kind === "exact") printMemberLine("", r.member);
        else if (r.kind === "ambiguous") r.candidates.forEach((c) => printMemberLine("  ? ", c));
        else console.log(`未找到「${ref}」`);
      }
      break;
    }
    case "add": {
      const [memberId, name, aliasStr] = args;
      if (!memberId || !name) throw new Error("用法: add <member_id> <姓名> [别名,别名]");
      const m = reg.add({ member_id: memberId, name, aliases: aliasStr ? aliasStr.split(",") : [], timem_user_ids: [] });
      console.log(`已添加: ${m.name} (${m.member_id}); 下一步: cli bind ${memberId} <user_id>`);
      break;
    }
    case "bind": {
      const [memberId, userId] = args;
      if (!memberId || !userId) throw new Error("用法: bind <member_id> <user_id>");
      // 绑定前探测, 给操作者一个确认依据
      if (process.env.TIMEM_API_KEY) {
        const svc = new TeamMemoryService({ apiKey: process.env.TIMEM_API_KEY, baseUrl: process.env.TIMEM_BASE_URL, registryPath: REGISTRY_PATH });
        const p = await svc.probe(userId);
        console.log(`[probe] user_id ${userId}: ${p.live ? `有记忆 (${p.sample_count} 条样本)` : "未搜到记忆 (仍可绑定)"}${p.error ? ` — ${p.error}` : ""}`);
        if (p.sample_topics.length) console.log(`[probe] 样本: ${p.sample_topics.slice(0, 3).join(" | ")}`);
      }
      reg.bind(memberId, userId);
      console.log(`已绑定 ${userId} → ${reg.mustGet(memberId).name}`);
      break;
    }
    case "unbind": {
      const [memberId, userId] = args;
      if (!memberId || !userId) throw new Error("用法: unbind <member_id> <user_id>");
      reg.unbind(memberId, userId);
      console.log(`已解绑 ${userId} ← ${memberId}`);
      break;
    }
    case "rm": {
      if (!reg.remove(args[0])) throw new Error(`未找到成员: ${args[0]}`);
      console.log(`已删除: ${args[0]}`);
      break;
    }
    case "query": {
      const [ref, ...q] = args;
      if (!ref || !q.length) throw new Error("用法: query <成员|all> <问题...>");
      const svc = makeService();
      const res = await svc.query(ref, q.join(" "));
      if (res.resolveHint) console.log(`※ ${res.resolveHint}`);
      if (res.member) console.log(`成员: ${res.member.name} (user_id: ${res.user_ids.join(", ") || "无"})`);
      if (res.errors.length) res.errors.forEach((e) => console.error(`✗ ${e}`));
      if (!res.memories.length) {
        console.log("未命中任何记忆。");
        break;
      }
      console.log(`命中 ${res.memories.length} 条:\n`);
      for (const it of res.memories) {
        const owner = it.member ? `${it.member.name}` : it.resolved_user_id ? `⚠未登记(${it.resolved_user_id})` : "未知";
        console.log(`  [${owner}] (${(it.score ?? 0).toFixed(3)}) ${it.content.slice(0, 160)}`);
      }
      const unknown = svc.registry.unknownUserIds;
      if (unknown.length) {
        console.log(`\n⚠ 发现未登记 user_id: ${unknown.map(([id, n]) => `${id}(${n}次)`).join(", ")} — 核对后用 cli bind 补录`);
      }
      break;
    }
    case "probe": {
      const svc = makeService();
      for (const uid of args) {
        const p = await svc.probe(uid);
        console.log(`${p.live ? "●" : "○"} ${uid}: ${p.live ? `有记忆 (${p.sample_count})` : "无记忆"}${p.bound_to ? ` → ${p.bound_to.name}` : " → 未登记"}${p.error ? ` ✗ ${p.error}` : ""}`);
        p.sample_topics.slice(0, 3).forEach((t) => console.log(`    · ${t}`));
      }
      break;
    }
    case "unknown": {
      const u = reg.unknownUserIds;
      if (!u.length) console.log("暂无观察记录 (unknown 由 query 命令在运行中累积, 仅内存态)。");
      else u.forEach(([id, n]) => console.log(`${id} (出现 ${n} 次)`));
      break;
    }
    case "report": {
      // 用法: report [--send] [--date today|yesterday|YYYY-MM-DD]
      //       2026-10-08 改版：紧凑数据 + LLM 综述——
      //       按项目（done/doing/todo）+ 按人（关键价值），LLM 负责措辞与提炼
      const send = args.includes("--send");
      const dateIdx = args.indexOf("--date");
      const date = resolveDate(dateIdx >= 0 ? args[dateIdx + 1] : "today");
      const svc = makeService();
      const rep = await buildDayReport(svc, date);
      const memoriesByMember = rep.members.map((m) => ({
        memberName: m.member.name,
        count: m.memories.length,
        sample: m.memories[0]?.content?.replace(/\s+/g, " ").slice(0, 60),
        samples: m.memories.slice(0, 2).map((it) => (it.content ?? "").replace(/\s+/g, " ").slice(0, 100)),
      }));

      // 2026-10-09 改版：正文直接由 LLM 按「按项目/按人」罗列（2026-10-08 的
      // 「综述段落 + 原始数据附录」两段式里附录价值低，已去掉）。
      // 输入物料用 briefing（完整标题+执行人+记忆线索），输出失败回退紧凑结构化文本。
      const [structured, briefing] = await Promise.all([
        buildCompactDailyReport(date, memoriesByMember),
        buildDailyBriefing(date, memoriesByMember),
      ]);
      let text = structured;
      const sumCfg = resolveSummarizeConfig();
      if (sumCfg) {
        console.error(`(LLM 综述中: model=${sumCfg.model} …)`);
        const sys = "你是研发团队的日报编辑。日报是总结性的：只总结已完成/已推进的工作，不写计划。\n" +
          "根据给定的今日工作数据，直接输出如下格式的纯文本日报正文：\n" +
          "第一行写「按项目」；之后每个项目最多三行：\n" +
          "『- 项目名：完成…；进行中…』（今日动态一行概括，某小句无内容就省略）；\n" +
          "『- 项目名·阶段目标：…』（用数据里的「阶段目标」行，没有就不写此行）；\n" +
          "『- 项目名·与目标差距：还差…』（只能从该项目的待办/受阻任务归纳，如「还差：A、B」；无待办写「还差：无」；禁止编造数据里没有的差距）。\n" +
          "然后一行写「按人」；之后每个有动态的人最多三行：\n" +
          "『- 姓名·任务台账：完成：…；未完成：…』（内容只取该人「台账指派」行，任务自带[完成]/[进行中]/[待办]标记：[完成]归入完成，其余归入未完成；某侧无内容就省略该侧小句；无台账任务就省略此行）；\n" +
          "『- 姓名·记忆：…』（内容只取该人「记忆线索」行，并先分拣：他本人承诺/要做的直接写；他安排别人的写成『已安排某某做某事』；" +
          "仅提及或关注的写成『关注/跟进某事』；分不清的末尾标「(推测)」，禁止把安排别人的事写成他自己要做）；\n" +
          "数据【PR 动态】里「已合并」的 PR 是当天成果证据：优先按项目写进『- 项目名：完成…』的完成小句（如「合并 PR N 个」或点出关键 PR）；" +
          "「在途」的 PR 只能写进进行中，禁止写成已完成；PR 信息已在项目行体现的，按人段落不再重复列；\n" +
          "数据【工作风险】段有该人风险时，在该人最后一行行尾用『工作风险：…』点出（按项目归组说明，不夸大不编造）。\n" +
          "输入末尾的【人名对照】里＝左右是同一人的不同称呼：按人输出必须一人一组（最多三行），" +
          "姓名统一用＝左边的显示名（中文名），把同一人的所有内容合并进同一组，禁止同一人拆成两组。\n" +
          "硬性要求：概括提炼而非逐条罗列，每行不超过 70 字；完成与未完成必须分开写清，禁止混在同一小句里；" +
          "覆盖数据里所有项目和所有有动态的人；禁止编造数据里没有的内容；不要 markdown 标题、代码块或加粗。";
        const usr = "今日工作数据：\n" + briefing;
        const body = await callLlm(sumCfg, sys, usr);
        if (body) text = `📋 工作日报 · ${date}（总结）\n\n${body}`;
      }

      console.log(text);
      printJobStats("report", rep.members);
      if (send) {
        const chatId = process.env.FEISHU_REPORT_CHAT_ID ?? DEFAULT_REPORT_CHAT_ID;
        const n = await sendGroupTextChunked(chatId, text);
        console.log(`\n✅ 已推送到飞书群 (${chatId}), 共 ${n} 条消息`);
      }
      break;
    }
    case "morning": {
      // 用法: morning [--send] [--raw] [--date today|YYYY-MM-DD]
      //       2026-10-09 改版（对齐日报风格）：正文由 LLM 按「按项目/按人」罗列，
      //       重点呈现 todo（按项目今日待办 + 按人待办与近 3 天计划线索）
      const send = args.includes("--send");
      const raw = args.includes("--raw");
      const dateIdx = args.indexOf("--date");
      const date = resolveDate(dateIdx >= 0 ? args[dateIdx + 1] : "today");
      const svc = makeService();
      const rep = await buildDayPlan(svc, date);
      const planMemories = rep.members.map((m) => ({
        memberName: m.member.name,
        count: m.memories.length,
        sample: m.memories[0]?.content?.replace(/\s+/g, " ").slice(0, 60),
        samples: m.memories.slice(0, 3).map((it) => (it.content ?? "").replace(/\s+/g, " ").slice(0, 100)),
      }));

      const [structured, briefing] = await Promise.all([
        buildCompactMorningReport(date, planMemories),
        buildMorningBriefing(date, planMemories),
      ]);
      let text = structured;
      const sumCfg = raw ? null : resolveSummarizeConfig();
      if (sumCfg) {
        console.error(`(LLM 综述中: model=${sumCfg.model} …)`);
        const sys = "你是研发团队的晨报编辑。晨报是【计划性文档】：全部内容都是「计划/进行中」，绝对不是已完成事项的汇报——\n" +
          "这是晨报与日报的本质区别，宁可漏写也不能让读者把任何内容误读为已完成。\n" +
          "根据给定的台账梳理数据，直接输出如下格式的纯文本晨报正文：\n" +
          "第一行必须原样输出：「【晨报·计划】以下均为计划与进行中事项，非已完成；完成情况见当日日报。」\n" +
          "第二行写「按项目」；之后每个项目一到两行（数据里有「进行中」行的项目写两行）：\n" +
          "『- 项目名：今天要推进什么（执行人谁）』（今日待办概括，含执行人，措辞用「要推进/计划/安排」等计划语气）；\n" +
          "『- 项目名·进行中：…』（用数据里的「进行中」行概括各项目当前推进状态，措辞用「推进中/正在做」；没有就不写此行）；\n" +
          "项目名后括注该项目的阶段目标（数据里有「阶段目标」行就用它，没有就不写）。\n" +
          "然后一行写「按人」；之后每个有动态的人一行，格式『- 姓名：今天重点做什么』；\n" +
          "按人只取该人[待办]/[进行中]/[受阻]标记的任务来写；带[完成]标记的是已经完成的事，禁止写成今天要做或正在做；只完成过、今天没事做的人不要出现。\n" +
          "数据【工作风险】段有该人的风险时，在其行尾用『工作风险：…』点出（按项目归组说明，不夸大不编造）。\n" +
          "按人的可靠度规则：输入里「台账指派」的内容是有人明确指派的，直接写成他今天要做；\n" +
          "「记忆线索」只说明与他相关，必须先分拣——他本人承诺/计划的写成他的任务，他安排别人的写成『已安排某某做某事』，" +
          "仅提及或关注的写成『关注/跟进某事』；来自记忆线索且分不清的末尾标「(推测)」，禁止把安排别人的事写成他自己要做。\n" +
          "输入末尾的【人名对照】里＝左右是同一人的不同称呼：按人输出必须一人一行，" +
          "姓名统一用＝左边的显示名（中文名），把同一人的所有内容合并进同一行，禁止同一人拆成两行。\n" +
          "硬性要求：概括提炼而非逐条罗列，每行不超过 70 字；覆盖数据里所有项目和所有有动态的人；" +
          "可在行尾补半句跨人/跨项目的协作顺序或风险提醒；禁止编造数据里没有的内容；不要 markdown 标题、代码块或加粗。";
        const usr = "台账梳理数据：\n" + briefing;
        const body = await callLlm(sumCfg, sys, usr);
        if (body) text = `🌅 工作晨报 · ${date}（计划 · 尚未完成）\n⚠️ 性质声明：本晨报为计划性文档，内容均为「计划/进行中」事项，不是已完成事项；完成情况以当日《工作日报》为准。\n\n${body}`;
      }

      console.log(text);
      printJobStats("morning", rep.members);
      if (send) {
        const chatId = process.env.FEISHU_REPORT_CHAT_ID ?? DEFAULT_REPORT_CHAT_ID;
        const n = await sendGroupTextChunked(chatId, text);
        console.log(`\n✅ 已推送到飞书群 (${chatId}), 共 ${n} 条消息`);
      }
      break;
    }
    default:
      console.log("用法: cli <list|who|add|bind|unbind|rm|query|probe|unknown|report|morning> [...]\n  report [--send] [--raw] [--date ...]  # 日报: 当天回顾 (每人摘要+跨人关联), 定时 18:30\n  morning [--send] [--raw] [--date ...] # 晨报: 今天可能要完成的内容, 定时早上");
      process.exitCode = cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
