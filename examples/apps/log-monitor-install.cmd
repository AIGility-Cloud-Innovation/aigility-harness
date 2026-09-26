@echo off
rem Log Monitor - one-click auto-start installer (Windows scheduled task, hidden window)
rem Usage: double-click me. Re-running = reinstall. Uninstall: log-monitor-uninstall.cmd
setlocal
cd /d "%~dp0"

rem ---- locate node.exe (PATH first, fallback default install dir) ----
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (if not defined NODE_EXE set "NODE_EXE=%%i")
if not defined NODE_EXE (if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe")
if not defined NODE_EXE (
  echo [FAIL] node.exe not found, install Node.js 18+ first
  pause & exit /b 1
)
echo [1/4] node: %NODE_EXE%

rem ---- kill stale instance on :39467 to avoid duplicate alerts ----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :39467 ^| findstr LISTENING') do (
  echo [2/4] stop old instance pid=%%p
  taskkill /f /pid %%p >nul 2>&1
)

rem ---- generate hidden launcher (wscript wrapper, no console window) ----
> "%~dp0log-monitor-run-hidden.vbs" echo CreateObject("Wscript.Shell").Run """%NODE_EXE%"" ""%~dp0log-monitor-daemon.js""", 0, False

rem ---- register scheduled task (trigger: at logon), then start once now ----
set "TASK=AigilityLogMonitor"
schtasks /delete /tn %TASK% /f >nul 2>&1
schtasks /create /tn %TASK% /tr "wscript.exe %~dp0log-monitor-run-hidden.vbs" /sc onlogon /f
if errorlevel 1 (
  echo [FAIL] task creation failed, try Run as administrator
  pause & exit /b 1
)
schtasks /run /tn %TASK% >nul 2>&1
echo [3/4] task %TASK% registered and started
echo [4/4] done. Dashboard: http://localhost:39467/  (first run: copy log-monitor-daemon-config.example.json to log-monitor-daemon-config.json, fill real address)
pause
