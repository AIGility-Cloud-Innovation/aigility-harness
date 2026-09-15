@echo off
setlocal
chcp 65001 >nul
rem ============================================================
rem  AppBase one-click stop (local helper -- git-ignored like
rem  start-appbase.cmd). Kills the process listening on :3419.
rem  The PG container (appbase-pg) is NOT touched: it keeps its
rem  restart policy and data, restarting the app is cheap.
rem
rem  NOTE: keep ASCII-only with CRLF, same reason as start script.
rem ============================================================

set "KILLPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3419" ^| findstr "LISTENING"') do set "KILLPID=%%p"
if not defined KILLPID (
  echo [stop-appbase] AppBase is not running ^(nothing listening on 3419^).
  exit /b 0
)

echo [stop-appbase] stopping AppBase (PID %KILLPID%) ...
taskkill /PID %KILLPID% /F >nul 2>nul

rem give the socket a moment to close, then verify
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":3419" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo [stop-appbase] stopped. Start again with: start-appbase.cmd
  exit /b 0
)
echo [stop-appbase] WARN: something is still listening on 3419.
exit /b 1
