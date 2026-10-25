/**
 * 一次性脚本：把 2026-10-25 排查出的 6 条困难点登记为飞书任务卡（P 计划中），等对齐器收编。
 * 归属清单按仓库划分：harness 问题 → AIGility-Cloud-Innovation；timem 后端 → TiMEM-AI。
 * 用法: cd /home/johnny/AI/aigility-harness && \
 *   ./node_modules/.bin/tsx examples/feishu-task-loop/scripts/create-2026-10-25-taskbooks.ts
 */
import { loadEnv } from "../src/env.js";
import { readTokenEnv, getFreshUserToken } from "../../../packages/layer-action/src/feishu-api.js";

loadEnv();
const BASE = "https://open.feishu.cn";

async function api(method: string, path: string, query?: Record<string, string>, body?: unknown) {
  const tok = await getFreshUserToken(readTokenEnv(), BASE);
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const resp = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await resp.json()) as any;
}

interface Book {
  list: string;
  summary: string;
  description: string;
}

const HARNESS = "AIGility-Cloud-Innovation";
const TIMEM = "TiMEM-AI";

const BOOKS: Book[] = [
  {
    list: HARNESS,
    summary:
      "[AIGility-Cloud-Innovation/aigility-harness] 修复 worker-team 分支已存在导致任务反复失败（worktree 未走兜底）",
    description: [
      "现状：任务 tsk_06219670 连续失败 5 次，错误恒为「工作区准备失败（worktree）：Command failed: git -C .../timem_console_frontend worktree add -b agent/timem-console-3ce638 ... 致命错误：一个名为 'agent/timem-console-3ce638' 的分支已经存在」。",
      "packages/layer-orchestration/src/worktree-manager.ts:229-242 已写兜底（catch 到 already exists|已经存在 时改执行 worktree add <path> <branch> 复用现有分支），但现场仍失败。说明失败点不在 ensureWorktree 内部，而在更外层：报错文案「准备工作区（新分支 …）」不是 git 输出，是调用方自己拼的，真正的 worktree add -b 可能在别处执行。",
      "过程方法：①全仓检索「准备工作区」定位文案拼接点；若源码无此串，检查 dist/ 编译产物是否落后于 src/（构建未重跑导致跑旧逻辑）；②找到真正执行 worktree add -b 的调用点，确认是否绕过 ensureWorktree 兜底；③统一收敛到 ensureWorktree，分支已存在时复用（保留历史便于续跑）而非重新 -b；④补回归测试：预建同名分支再调 ensureWorktree，断言 ok:true 且不抛错；⑤同一任务连续失败超 2 次时，日志必须打印完整命令行与 git 原始 stderr（现在被截断成一句中文提示，无法定位）。",
      "边界：不用 -B 强推覆盖已有分支（会丢上一轮未推送提交）；不删除用户分支；只改工作区准备链路，不动 pr-finisher 提交逻辑。",
      "目标：同名分支已存在时能复用该分支继续跑；tsk_06219670 这类任务不再 5 连败；新增回归测试通过。",
      "执行者：agent",
    ].join("\n"),
  },
  {
    list: HARNESS,
    summary:
      "[AIGility-Cloud-Innovation/aigility-harness] 收尾提交排除 .backups 等忽略路径（现在被当产出提交导致交付失败）",
    description: [
      "现状：任务 tsk_c03ce9c0 收尾失败，日志为「git -c core.quotePath=false add -- .backups/claude-2026-10-22T16-07-24/index.html ... .backups/codex-2026-10-24T13-47-22/ ...」。worker 改文件前会在仓库内留 .backups/<agent>-<时间戳>/ 备份目录，收尾器用 git add -- <改动清单> 时把它当正常改动一并纳入，随后失败。",
      "过程方法：①在 pr-finisher 的改动收集处（packages/layer-orchestration/src/pr-finisher.ts）增加忽略规则，与 .gitignore 同源：.backups/、node_modules/、dist/、*.log、.pytest_cache/、.hermes/；②优先复用 git status --porcelain 配合 git check-ignore 判定，而非自维护白名单，避免规则漂移；③被忽略路径要打印一行汇总日志（已跳过 N 个忽略路径），便于事后核对；④补单测：工作区同时存在 src/a.ts（应提交）与 .backups/x/index.html（应跳过），断言提交清单只含前者。",
      "边界：不要 git add -A 后统一 reset（会误伤 worker 真实产出）；不要删除 .backups/ 目录本身（它是回溯依据）；不改 .gitignore 内容语义。",
      "目标：收尾提交只含真实代码改动；含 .backups/ 的工作区不再因此失败；单测覆盖应提交/应跳过两类路径。",
      "执行者：agent",
    ].join("\n"),
  },
  {
    list: HARNESS,
    summary:
      "[AIGility-Cloud-Innovation/aigility-harness] 「待确认仓库」任务全线卡死：改为先确认执行人再确认仓库",
    description: [
      "现状：日志里数十条任务永久停在 P 组，反复输出「🏷️『【待确认仓库】xxx』尚未确认归属，留 P。群里回复『任务归属 编号 @仓库』确认后自动创建工单。」这些任务既没有确认仓库也没有确认执行人，于是永远无法进入执行队列。",
      "用户 2026-10-25 拍板流程调整：先确认执行人，再确认仓库——很多任务在执行人明确后，仓库由执行人自己就能定，不必等负责人指定。",
      "过程方法：①梳理 packages/layer-orchestration/src/task-issue-sync.ts 中 normalizeGateTags 与【待确认仓库】的判定与跳建单逻辑，画出当前决策顺序；②改为两段式：缺执行人 → 打【待安排执行者】，提示「群里回复『执行者 编号 @人名』」；执行人已明确但缺仓库 → 才打【待确认仓库】，提示「回复『任务归属 编号 @仓库』」；③若执行人已明确且描述或标题能推断仓库（如标题已带 [org/repo#N]），直接放行不再打【待确认仓库】；④两个标签互斥，不允许同时出现，扩展 normalizeGateTags 而非新写一套；⑤补测试：分别断言仅缺执行人、仅缺仓库、两者都缺三种输入产生的标签与提示文案。",
      "边界：不改已有【待确认仓库】任务的历史数据（只在下一拍按新顺序重判）；不动 D/C/A 组分组语义；不新增分组。",
      "目标：缺执行人的任务优先被识别并要求安排执行人；执行人明确后不再被待确认仓库卡住；标签与提示文案一一对应且互斥。",
      "执行者：agent",
    ].join("\n"),
  },
  {
    list: HARNESS,
    summary:
      "[AIGility-Cloud-Innovation/aigility-harness] 台账文件禁止外部脚本直改：补 registry-cli + 原子写盘",
    description: [
      "现状：config/task-registry.local.json 由运行中的 task-loop 进程持有内存副本，写盘策略是 1 秒合并写（TaskRegistry.markDirty → setTimeout(flushSync, 1000)）。任何外部脚本直接读写该 JSON，都会被下一次 flushSync() 用内存旧值整体覆盖，改动静默丢失。2026-10-25 排查时实际踩到该坑（想改台账状态但不敢直改文件）。",
      "过程方法：①在 TaskRegistry 上补对外 CLI 入口（如 scripts/registry-cli.mts），提供 get / set-status / set-description / list，语义与进程内 API 一致；②若必须多进程写同一文件，采用锁文件 + 读-改-写 + mtime 校验，写前比对 mtime，发现被他人改过就重新读入再合并，而非直接覆盖；③flushSync() 落盘改为原子写（写 *.tmp 再 rename()），避免半截 JSON 导致 recover 失败；④在台账目录放 README，写明该文件由 task-loop 独占、外部请用 registry-cli；⑤补测试：模拟外部改文件后进程 flush，断言不丢外部改动（或明确报冲突而非静默覆盖）。",
      "边界：不改写盘节流策略（1 秒合并写是为性能）；不允许起第二个 task-loop 实例（会状态翻转，已有铁律）；已存在的台账记录不得丢失。",
      "目标：外部脚本改变更时不再被静默覆盖；落盘原子化不会出现半截 JSON；有明确使用约定文档。",
      "执行者：agent",
    ].join("\n"),
  },
  {
    list: HARNESS,
    summary:
      "[AIGility-Cloud-Innovation/aigility-harness] 对外写入的 PR 链接必须经 Gitea API 回查校验，禁止凭上下文推断",
    description: [
      "现状：2026-10-25 给 PingCode 回填链接时，凭对话记忆写了「前端 PR #89」，实际 #89 是「峰谷系数/折扣规则改为可搜索下拉」，与本特性无关；真正对应的是 PR #88（已合并，merge commit 6cc8b8b）。若照记忆写入，PingCode 卡片会挂一个完全无关的 PR。同类风险：worker-team 汇报里也出现过 PR 编号与任务不匹配的错仓交付。",
      "过程方法：①任何对外写入 PR 链接的动作（PingCode 描述、飞书任务描述、台账 links）都必须先调 GET /repos/{org}/{repo}/pulls/{number}，校验 title / head.ref / base.ref 与当前任务语义一致，不一致则拒绝写入并报错；②PR 编号来源只能是 worker-team 交付返回值、git log 分支名反查、用户明确提供三种，不得从对话上下文推断；③回填后将 PR 链接写入台账 links 字段，作为后续核验的唯一事实源；④补校验函数 + 单测：给定标题与任务不符的 PR，断言抛出并阻止写入。",
      "边界：不因校验失败就丢弃已交付的 PR；报错要包含 PR 实际标题便于人快速判断；不为通过校验而放宽匹配规则。",
      "目标：对外写入的 PR 链接 100% 经过 API 校验；同类链接挂错问题不再发生。",
      "执行者：agent",
    ].join("\n"),
  },
  {
    list: TIMEM,
    summary:
      "[TiMEM-AI/timem-platform-backend] 对公打款 OCR 假实现落地：补 paddlepaddle 依赖 + 去静默兜底 + LLM 视觉第二通道",
    description: [
      "现状（已实测非推断）：①utils/file_processing/image_OCR_util.py 基于 PaddleOCR，首行 from paddleocr import PaddleOCR；②虚拟环境里 paddleocr==2.10.0 已装但 paddlepaddle 从未安装，导入直接 ModuleNotFoundError: No module named 'paddle'；③requirements.txt 与 requirements-docker.txt 只写了 paddleocr==2.10.0，没有 paddlepaddle，依赖清单本身就是错的；④PR #270 的 app/console/service/bank_transfer_service.py _default_ocr_client() 把导入失败静默吞掉，返回 UnavailableOCR（extract_text 永远返回空串），后果是线上永不报错、OCR 永远空、ocrReviewState 永远不是 suggest_approve、前端「已通过 AI 审核」标记永远渲染不出来；⑤PR #87（前端 draft）读取 voucherOcr / ocrReviewReasons / ocrReviewState / ocrReviewStateLabel 四字段，而后端 _record_to_view() 返回的 BankTransferView 一个都没有，合并即上线不报错的空功能；⑥PR #270 的 bank_transfer_ocr.py（232 行）框架完整（字段提取、金额/账号/日期归一化、与提交信息比对、not_processed/failed/needs_review/suggest_approve 状态判定），唯一缺 VoucherOCRClient 真实实现。",
      "视觉模型实测结论（用自造银行回单，图内真值：北京宇乐树 / 12345.00 / 20261022ABC778899001 / 2026-10-22）：准确的有 claude-sonnet-4-6、claude-sonnet-5、claude-haiku-4-5、bigmodel-glm-5.3-flash、qwen3.8-max、deepseek-v4.1-flash；会编造的是 bigmodel-glm-4.6（返回了杭州壹网壹创 / 1080.00 / 2023-08-15，完全不同的一张回单），此类模型绝不可用于财务场景；不可用的是 qwen3.5（图片转换失败）、sensenova-u1-fast（404 模型不存在）。",
      "过程方法：①补依赖：requirements.txt 与 requirements-docker.txt 加 paddlepaddle（CPU 版，锁版本，与 paddleocr==2.10.0 兼容），本地装好跑通 ImageOCRUtil.extract_text_sync() 对真实回单的识别；②拆掉静默兜底：_default_ocr_client() 失败时不再返回永远空串的桩，改为返回 None 并在服务层显式降级为 failed 状态 + error 级日志，或直接抛配置异常阻止启动，原则是能力缺失必须可见不能伪装成识别不出；③实现 VoucherOCRClient 适配器，把 ImageOCRUtil.extract_text 包成协议实现（async extract_text(bytes) -> str）；④加视觉 LLM 第二通道，走 claude-haiku-4-5 或 deepseek-v4.1-flash（成本低且实测准确），用于 PaddleOCR 识别为空或置信度低的回单，提示词要求只输出 JSON 且禁止推测，识别不到填 null；⑤加禁止编造防线：LLM 返回的每个字段必须能在 OCR 原文中做子串或归一化匹配，匹配不上就置 null 并降为 needs_review，金额、日期、流水号三项任一缺失即不得给出 suggest_approve；⑥后端投影字段：_record_to_view() 补 voucher_ocr / ocr_review_reasons / ocr_review_state / ocr_review_state_label 四字段，与 PR #87 类型定义对齐；⑦联调通过后才解除 PR #87 的 draft。",
      "边界：OCR 结果只作辅助复核，永远不能自动批准入账（bank_transfer_ocr.py 现有 advisory only 设计必须保持）；不因识别失败拒绝用户提交申请；不把 claude-opus 这类高成本模型设成默认；不在代码里硬编码任何 API key。",
      "目标：真实回单能被识别出金额/付款户名/流水号/日期四项；识别失败时状态明确可见而非静默空串；前端「已通过 AI 审核」标记在有真实 OCR 数据时能正确渲染；paddlepaddle 进依赖清单且干净环境可复现。",
      "执行者：agent",
    ].join("\n"),
  },
];

const listResp = await api("GET", "/open-apis/task/v2/tasklists", { page_size: "50" });
const allLists = listResp?.data?.items ?? [];
const secCache = new Map<string, string>();

async function ensureSection(listGuid: string, listName: string): Promise<string> {
  if (secCache.has(listGuid)) return secCache.get(listGuid)!;
  const secsResp = await api("GET", "/open-apis/task/v2/sections", {
    resource_type: "tasklist",
    resource_id: listGuid,
    page_size: "50",
    user_id_type: "open_id",
  });
  const sec = (secsResp?.data?.items ?? []).find((x: any) => x.name === "P 计划中");
  if (!sec) throw new Error(`清单「${listName}」缺少分组「P 计划中」`);
  secCache.set(listGuid, sec.guid);
  return sec.guid;
}

console.log(`准备建 ${BOOKS.length} 张卡\n`);
const created: { summary: string; guid: string; list: string }[] = [];

for (const b of BOOKS) {
  const list = allLists.find((x: any) => x.name === b.list);
  if (!list) {
    console.error(`❌ 清单「${b.list}」不存在，跳过：${b.summary.slice(0, 40)}`);
    continue;
  }
  const sectionGuid = await ensureSection(list.guid, list.name);
  const cr = await api("POST", "/open-apis/task/v2/tasks", { user_id_type: "open_id" }, {
    summary: b.summary,
    description: b.description,
  });
  if ((cr?.code ?? -1) !== 0) {
    console.error(`❌ 建任务失败: code=${cr?.code} ${cr?.msg} | ${b.summary.slice(0, 40)}`);
    continue;
  }
  const task = cr?.data?.task;
  const at = await api("POST", `/open-apis/task/v2/tasks/${task.guid}/add_tasklist`, { user_id_type: "open_id" }, {
    tasklist_guid: list.guid,
    section_guid: sectionGuid,
  });
  const ok = (at?.code ?? -1) === 0;
  console.log(`${ok ? "✅" : "⚠️"} 「${b.list}」${b.summary.slice(0, 52)}…`);
  console.log(`     guid=${task.guid} 挂P组=${ok ? "成功" : `失败(${at?.msg})`}`);
  created.push({ summary: b.summary, guid: task.guid, list: b.list });
}

console.log(`\n完成：成功 ${created.length}/${BOOKS.length}`);
console.log("注：TASK_AUTO_DISPATCH=0，卡留在 P 组，需人工挪到 D 组才授权派发。");
