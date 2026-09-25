@echo off
rem 团队晨报定时任务入口 (早上): 今天可能要完成的内容
chcp 65001 >nul
setlocal
cd /d "C:\Users\Administrator\AI\aigility-harness\examples\team-memory-console"
call pnpm exec tsx src/cli.ts morning --send --date today >> "%~dp0report-last-run.log" 2>&1
endlocal
