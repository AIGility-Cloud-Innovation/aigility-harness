/**
 * 编码代理通用工具: AI 改动前的沙箱快照备份
 *
 * 在 codex / zcode / claude 任一编码代理 spawn 之前调用:
 * 把 cwd 下所有 *.html 复制到 <cwd>/.backups/<时间戳>/, 保留最近 10 份。
 * 出问题时可从 .backups 手动恢复 (不污染主仓库 git 历史)。
 */

import { mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const MAX_BACKUPS = 10;

export function backupHtmlFiles(cwd: string, traceTag = ""): string | null {
  try {
    const files = readdirSync(cwd).filter((f) => f.endsWith(".html"));
    if (files.length === 0) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupDir = join(cwd, ".backups", (traceTag ? traceTag + "-" : "") + ts);
    mkdirSync(backupDir, { recursive: true });
    for (const f of files) copyFileSync(join(cwd, f), join(backupDir, f));
    pruneOldBackups(join(cwd, ".backups"));
    return backupDir;
  } catch {
    return null; // 备份失败不阻塞编码任务
  }
}

function pruneOldBackups(backupsRoot: string): void {
  try {
    const dirs = readdirSync(backupsRoot)
      .map((d) => join(backupsRoot, d))
      .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
      .sort();
    while (dirs.length > MAX_BACKUPS) {
      const oldest = dirs.shift();
      if (oldest) rmSync(oldest, { recursive: true, force: true });
    }
  } catch { /* 忽略清理失败 */ }
}
