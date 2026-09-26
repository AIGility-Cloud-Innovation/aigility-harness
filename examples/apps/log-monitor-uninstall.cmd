@echo off
rem Log Monitor - remove auto-start: delete scheduled task + stop daemon + clean launcher
setlocal
cd /d "%~dp0"
schtasks /delete /tn AigilityLogMonitor /f
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :39467 ^| findstr LISTENING') do taskkill /f /pid %%p >nul 2>&1
del "%~dp0log-monitor-run-hidden.vbs" 2>nul
echo Auto-start task removed and daemon stopped.
pause
