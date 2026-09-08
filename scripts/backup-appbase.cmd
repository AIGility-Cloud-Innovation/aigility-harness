@echo off
rem ============================================================
rem  AppBase daily database backup (pg_dump custom format)
rem  Keeps the latest %KEEP_DAYS% days of dumps in BACKUP_DIR.
rem  Register scheduled task:
rem    schtasks /Create /TN "AppBase Daily Backup" /SC DAILY /ST 03:00 /TR "<absolute path of this file>" /F
rem  NOTE: keep this file ASCII-only (cmd parses it with the OEM codepage).
rem ============================================================
setlocal
set PG_CONTAINER=appbase-pg
set BACKUP_DIR=D:\AppBaseBackups
set KEEP_DAYS=14

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set STAMP=%%i
set DUMP_FILE=%BACKUP_DIR%\appbase-%STAMP%.dump

docker exec %PG_CONTAINER% pg_dump -U postgres -d appbase -Fc > "%DUMP_FILE%"
if errorlevel 1 (
  echo BACKUP FAILED >&2
  del /q "%DUMP_FILE%" 2>nul
  exit /b 1
)

rem also back up the token signing secret (losing it invalidates all logins)
copy /y "%~dp0..\examples\appbase\src\.token-secret" "%BACKUP_DIR%\token-secret.txt" >nul 2>&1

rem prune dumps older than KEEP_DAYS days
forfiles /p "%BACKUP_DIR%" /m appbase-*.dump /d -%KEEP_DAYS% /c "cmd /c del @path" 2>nul

echo BACKUP OK %DUMP_FILE%
endlocal
