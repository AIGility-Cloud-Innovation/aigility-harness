# 重置本机原生 PostgreSQL 的 postgres 口令（文档《启动与部署指南》坑 4 的自动化版本）
#
# 为什么必须管理员：pg_hba.conf 全是 scram-sha-256，口令未知就必然连不上；
# 而改完 pg_hba.conf 需要 reload 才生效，实测普通权限执行 pg_ctl reload 会报
# "could not send reload signal ...: Operation not permitted"。
#
# 流程（全程 try/finally，即使中途失败也一定还原 pg_hba.conf）：
#   1. 备份 pg_hba.conf
#   2. 在文件最顶部插入 127.0.0.1/32 与 ::1/128 的临时 trust 行（只针对 postgres 用户）
#   3. pg_ctl reload
#   4. 免密连上，ALTER USER postgres PASSWORD '...'
#   5. 用新口令回连验证
#   6. 还原 pg_hba.conf 并再次 reload
#
# 用法（必须用「管理员」PowerShell）：
#   # 不传口令：自动沿用 examples\appbase\start-appbase.cmd 里现有的 APPBASE_PG_PASSWORD
#   powershell -ExecutionPolicy Bypass -File scripts\reset-pg-password.ps1
#
#   # 想换成新口令：
#   powershell -ExecutionPolicy Bypass -File scripts\reset-pg-password.ps1 -NewPassword "new-secret"
#
# 安全提示：第 2~6 步之间，本机 127.0.0.1 对 postgres 用户是免密的，整个过程只有几秒，
#          但别在这期间离开。脚本结束会打印还原结果。

[CmdletBinding()]
param(
  [string]$NewPassword = "",
  [string]$PgData = "C:\Program Files\PostgreSQL\15\data",
  [string]$PgBin  = "C:\Program Files\PostgreSQL\15\bin",
  [string]$PgUser = "postgres",
  [int]$Port = 5432
)

$ErrorActionPreference = "Stop"

# ---- 0. 管理员检查（reload 必需，提前失败好过改完一半卡住）----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "需要管理员权限（pg_ctl reload 必需）。请以管理员身份重新打开 PowerShell 再执行本脚本。"
}

$psql  = Join-Path $PgBin "psql.exe"
$pgctl = Join-Path $PgBin "pg_ctl.exe"
foreach ($p in @($psql, $pgctl)) {
  if (-not (Test-Path $p)) { throw "找不到 $p —— 用 -PgBin 指定 PostgreSQL 的 bin 目录" }
}

$hba = Join-Path $PgData "pg_hba.conf"
if (-not (Test-Path $hba)) { throw "找不到 $hba —— 用 -PgData 指定数据目录" }

# ---- 1. 确定新口令 ----
if (-not $NewPassword) {
  $cmdPath = Join-Path (Split-Path -Parent $PSScriptRoot) "examples\appbase\start-appbase.cmd"
  if (-not (Test-Path $cmdPath)) {
    throw "未传 -NewPassword，且找不到 $cmdPath 用于沿用现有口令"
  }
  $hit = Select-String -Path $cmdPath -Pattern '^\s*set\s+APPBASE_PG_PASSWORD=' -CaseSensitive:$false | Select-Object -First 1
  if (-not $hit) { throw "未传 -NewPassword，且 $cmdPath 中没有 APPBASE_PG_PASSWORD=" }
  $NewPassword = ($hit.Line -replace '(?i)^\s*set\s+APPBASE_PG_PASSWORD=', '').TrimEnd("`r", "`n")
  Write-Host "[info] 沿用 start-appbase.cmd 里现有的口令（长度 $($NewPassword.Length)），脚本无需再改"
}
if ($NewPassword -eq "") { throw "口令为空，拒绝执行" }

# ALTER USER 里的单引号要转义
$sqlPassword = $NewPassword -replace "'", "''"

# ---- 2. 备份 + 插入临时 trust 行 ----
# 关键：必须无 BOM 写入。PowerShell 5.1 的 Out-File/Set-Content -Encoding utf8 会带 BOM，
# PG 读到带 BOM 的 pg_hba.conf 会报「无效连接类型」甚至拒绝启动（本机踩过）。
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$backup = Join-Path $PgData ("pg_hba.conf.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item $hba $backup -Force
$original = [System.IO.File]::ReadAllText($hba)
Write-Host "[backup] 已备份到 $backup"

$tmpBlock = @(
  "# [tmp] reset-pg-password.ps1 - temporary trust, auto-removed when the script exits",
  "host    all             $PgUser        127.0.0.1/32            trust",
  "host    all             $PgUser        ::1/128                 trust",
  ""
) -join "`r`n"
[System.IO.File]::WriteAllText($hba, $tmpBlock + $original, $utf8NoBom)
Write-Host "[edit] 已在 pg_hba.conf 顶部插入临时 trust 行（仅 $PgUser @ 127.0.0.1 / ::1）"

$ok = $false
try {
  # ---- 3. reload ----
  Write-Host "[reload] pg_ctl reload -D `"$PgData`""
  & $pgctl reload -D $PgData
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl reload 失败（exit $LASTEXITCODE）" }

  # ---- 4. 免密改口令 ----
  Start-Sleep -Seconds 1
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Write-Host "[alter] ALTER USER $PgUser PASSWORD '******'（口令不回显）"
  $alterOut = & $psql -h 127.0.0.1 -p $Port -U $PgUser -d postgres -w -v ON_ERROR_STOP=1 -c "ALTER USER $PgUser PASSWORD '$sqlPassword';" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "ALTER USER 失败：`n$alterOut" }
  Write-Host "[alter] ok"

  # ---- 5. 用新口令回连验证 ----
  $env:PGPASSWORD = $NewPassword
  $verify = & $psql -h 127.0.0.1 -p $Port -U $PgUser -d postgres -w -tAc "SELECT 1;" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "新口令验证失败：`n$verify" }
  Write-Host "[verify] 用新口令连接成功"
  $ok = $true
}
finally {
  # ---- 6. 无论如何都还原 pg_hba.conf ----
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($hba, $original, $utf8NoBom)
  Write-Host "[restore] pg_hba.conf 已还原为原来的 scram-sha-256（无 BOM）"

  & $pgctl reload -D $PgData
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "还原后的 reload 失败，请手动执行: & '$pgctl' reload -D '$PgData'"
  } else {
    Write-Host "[restore] reload ok"
  }
}

if ($ok) {
  Write-Host ""
  Write-Host "[done] postgres 口令已重置，pg_hba.conf 已恢复原状。"
  Write-Host "       现在可以跑 examples\appbase\start-appbase.cmd 了。"
}
