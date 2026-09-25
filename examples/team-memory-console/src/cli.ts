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
import { buildDayReport, buildDayPlan, renderReport, resolveDate } from "./report.js";
import { resolveSummarizeConfig, summarizeDayReport, summarizeDayPlan } from "./summarize.js";
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
      // 用法: report [--send] [--raw] [--date today|yesterday|YYYY-MM-DD]
      //       默认走 LLM 摘要 (每人概括 + 跨人关联); --raw 回退逐条罗列
      const send = args.includes("--send");
      const raw = args.includes("--raw");
      const dateIdx = args.indexOf("--date");
      const date = resolveDate(dateIdx >= 0 ? args[dateIdx + 1] : "today");
      const svc = makeService();
      const rep = await buildDayReport(svc, date);

      let text: string;
      const cfg = raw ? null : resolveSummarizeConfig();
      if (cfg) {
        console.error(`(LLM 摘要中: model=${cfg.model} …)`);
        const body = await summarizeDayReport(rep, cfg);
        if (body) {
          const total = rep.members.reduce((n, m) => n + m.memories.length, 0);
          const active = rep.members.filter((m) => m.memories.length).length;
          text = `📋 团队记忆日报 · ${rep.date}\n共 ${total} 条新记忆, ${active} 人有活动\n\n${body}`;
        } else {
          console.error("(LLM 摘要不可用, 回退逐条罗列)");
          text = renderReport(rep);
        }
      } else {
        text = renderReport(rep);
      }
      console.log(text);
      if (send) {
        const chatId = process.env.FEISHU_REPORT_CHAT_ID ?? DEFAULT_REPORT_CHAT_ID;
        const n = await sendGroupTextChunked(chatId, text);
        console.log(`\n✅ 已推送到飞书群 (${chatId}), 共 ${n} 条消息`);
      }
      break;
    }
    case "morning": {
      // 用法: morning [--send] [--raw] [--date today|YYYY-MM-DD]
      //       晨报: 今天可能要完成的内容 (计划类记忆, 近 3 天窗口); LLM 提炼, 失败回退罗列
      const send = args.includes("--send");
      const raw = args.includes("--raw");
      const dateIdx = args.indexOf("--date");
      const date = resolveDate(dateIdx >= 0 ? args[dateIdx + 1] : "today");
      const svc = makeService();
      const rep = await buildDayPlan(svc, date);

      let text: string;
      const cfg = raw ? null : resolveSummarizeConfig();
      if (cfg) {
        console.error(`(LLM 提炼中: model=${cfg.model} …)`);
        const body = await summarizeDayPlan(rep, cfg);
        const total = rep.members.reduce((n, m) => n + m.memories.length, 0);
        if (body) {
          text = `🌅 团队晨报 · ${rep.date}\n今天可能要完成的内容 (基于近 3 天 ${total} 条计划类记忆)\n\n${body}`;
        } else {
          console.error("(LLM 不可用, 回退逐条罗列)");
          text = `🌅 团队晨报 · ${rep.date}\n今天可能要完成的内容 (LLM 不可用, 以下为计划类记忆原文)\n\n${renderReport(rep)}`;
        }
      } else {
        text = renderReport(rep);
      }
      console.log(text);
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
