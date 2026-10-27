/**
 * 建一条「README 文档改动」验证任务，用于验证交付链基线修复。
 *
 * 目的（2026-10-27 用户拍板）：
 *   不再为 t102308 补单测/端到端；改为用一条**极小且必然成功**的新任务，
 *   在真实派发中观察「提交 → 推送 → 基线对齐 → 开 PR」全链路是否正常。
 *
 * 设计要点：
 *   - 纯文档改动（零代码风险）
 *   - 缺口真实：README 有「快速开始」但无「服务保活/守护进程」章节
 *   - 必然产生新改动 → 不会掉进「工作区无新改动」判定
 *   - 标题含【agent】+ [org/repo] → 满足派发条件
 */
import { userToken } from "./feishu-user-token.mts";

const LIST = "c9b5653d-c4d8-4ccc-bc0b-561ecbce11ba";
const P = "ba9c4d86-dcdd-479d-8093-2bd21782f9a5";

const SUMMARY = "【agent】[AIGility-Cloud-Innovation/aigility-harness] 文档：README 补充「服务保活」章节";

const DESCRIPTION = `【验证任务】本条为交付链基线修复的验证用例，范围刻意压到最小。

=== 背景 ===
2026-10-27 修复了交付前基线对齐缺陷（pr-finisher.ts detectBaseBranch 误取 agent/* 本地分支，
导致 merge-base 引用不存在的远程分支 → exit 128）。修复代码已入 main（提交 1a6bbb1），
但尚未在真实派发中被验证过。本条任务用于补齐这次验证。

=== 要做什么 ===
README.md 当前有「七、快速开始」，但**没有「服务保活 / 守护进程」相关章节**，
而这正是近期刚治理过的领域（详见 docs/服务保活设计-所有权唯一化.md）。
请在 README.md 的「七、快速开始」之后新增一节：

### 服务保活（task-loop 守护）

内容要点（依据 docs/服务保活设计-所有权唯一化.md 与 docs/systemd启动限流配置-可直接粘贴.md）：
1. 飞书任务流水线由 systemd 托管：\`systemctl --user status aigility-feishu-task-loop.service\`
2. 所有权唯一化原则：systemd 是唯一保活者，平台 managed-apps 中对应项已置 enabled:false
3. 启动限流：StartLimitIntervalSec / StartLimitBurst，防无限重启风暴
4. 日志位置：/tmp/aigility-feishu-task-loop.log
5. 常用排障命令（查重启计数 NRestarts、查锁文件等）

要求：只改 README.md，不改代码、不动配置；引用上述两份 docs 文件作为依据。

=== 交付要求 ===
仓库内新建分支完成修改（引用 Gitea 远端 origin），提交推送后创建 Gitea PR
（保持开启不合并），PR 链接写进最终汇报。
执行者：agent`;

async function main() {
  const T = await userToken();
  const url = "https://open.feishu.cn/open-apis/task/v2/tasks?user_id_type=open_id";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
    body: JSON.stringify({
      summary: SUMMARY,
      description: DESCRIPTION,
      // 建到清单后由 add_tasklist 指定 P 组
    }),
  });
  const d: any = await r.json();
  if (d.code !== 0) throw new Error(`建任务失败: ${d.code} ${d.msg}`);
  const guid = d.data?.task?.guid;
  console.log(`✅ 任务已创建 guid=${guid}`);
  console.log(`   标题: ${SUMMARY}`);

  // 挪进 P 组
  const mv = await fetch(`https://open.feishu.cn/open-apis/task/v2/tasks/${guid}/add_tasklist?user_id_type=open_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${T}` },
    body: JSON.stringify({ tasklist_guid: LIST, section_guid: P }),
  });
  const mvd: any = await mv.json();
  console.log(`${mvd.code === 0 ? "✅" : "❌"} 挪入 P 组: ${mvd.code} ${mvd.msg ?? ""}`);

  // 复核
  const chk: any = await (await fetch(`https://open.feishu.cn/open-apis/task/v2/tasks/${guid}?user_id_type=open_id`, { headers: { Authorization: `Bearer ${T}` } })).json();
  const t = chk.data?.task;
  console.log(`\n复核：`);
  console.log(`  标题      : ${t?.summary}`);
  console.log(`  描述长度  : ${(t?.description ?? "").length}`);
  console.log(`  completed : ${t?.completed_at ?? "0"} (0=未完成)`);
  console.log(`\n链接: https://applink.feishu.cn/client/todo/detail?guid=${guid}`);
}

main().catch((e) => { console.error("失败:", String(e)); process.exit(1); });