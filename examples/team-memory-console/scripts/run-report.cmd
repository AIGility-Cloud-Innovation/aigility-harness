@echo off
rem 团队记忆日报定时任务入口
chcp 65001 >nul
setlocal
cd /d "C:\Users\Administrator\AI\aigility-harness\examples\team-memory-console"
call pnpm exec tsx src/cli.ts report --send --date %1 >> "%~dp0report-last-run.log" 2>&1
endlocal
