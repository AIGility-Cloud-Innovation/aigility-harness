# 把便携版 Node 目录写进「用户级」PATH（本机 Node 用 zip 便携版，默认不在 PATH）。
#
# 为什么需要：用完整路径调 pnpm.cmd 时 pnpm 自己能靠同目录的 node.exe 启动，
# 但它派生依赖的生命周期脚本（postinstall 里的 `node xxx.js`）是从 PATH 找 node 的，
# 找不到就报  'node' 不是内部或外部命令，install 会因此中断（连 node_modules/.bin 都不会生成）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\add-node-to-path.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\add-node-to-path.ps1 -NodeDir "D:\其他\node"
#   powershell -ExecutionPolicy Bypass -File scripts\add-node-to-path.ps1 -Remove
#
# 特性：先备份，保留 PATH 原有的值类型（REG_EXPAND_SZ / REG_SZ），不截断、不排序、不覆盖现有条目。

[CmdletBinding()]
param(
  [string]$NodeDir = "D:\SiteWorkspace\tools\node-v24.19.0-win-x64",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$NodeDir = $NodeDir.TrimEnd('\')

if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) {
  throw "未找到 $NodeDir\node.exe —— 请用 -NodeDir 指定便携版 Node 目录"
}

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
if (-not $key) { throw "无法打开 HKCU\Environment（权限不足？）" }

$valueKind = $null
$current = $null
if ($key.GetValueNames() -contains "Path") {
  $valueKind = $key.GetValueKind("Path")
  # DoNotExpandEnvironmentNames：保留 %USERPROFILE% 之类的原始写法，不要展开成实体路径
  $current = [string]$key.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

# ---- 备份 ----
$repoRoot = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $repoRoot ".workbuddy\tmp\env-backup"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupFile = Join-Path $backupDir ("user-PATH-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".txt")
[System.IO.File]::WriteAllText($backupFile, [string]$current, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[backup] 原 PATH 已备份到: $backupFile"

$entries = @()
if ($current) { $entries = @($current -split ';' | Where-Object { $_.Trim() -ne '' }) }

if ($Remove) {
  $new = @($entries | Where-Object { $_.TrimEnd('\') -ne $NodeDir })
  if ($new.Count -eq $entries.Count) {
    Write-Host "[skip] PATH 中没有 $NodeDir ，无需移除"
    $key.Close()
    exit 0
  }
} else {
  if (@($entries | Where-Object { $_.TrimEnd('\') -eq $NodeDir }).Count -gt 0) {
    Write-Host "[skip] PATH 中已存在: $NodeDir"
    $key.Close()
    exit 0
  }
  # 前置：保证这个 node 优先命中，不被其他版本抢走
  $new = @($NodeDir) + $entries
}

$newValue = ($new -join ';')
if (-not $valueKind) { $valueKind = [Microsoft.Win32.RegistryValueKind]::ExpandString }

$key.SetValue("Path", $newValue, $valueKind)
$key.Close()

$action = "已加入" ; if ($Remove) { $action = "已移除" }
Write-Host "[ok] 用户级 PATH $action : $NodeDir"
Write-Host "     值类型: $valueKind（沿用原类型）"
Write-Host "     条目数: $($new.Count)   新 PATH 长度: $($newValue.Length)"
Write-Host ""
Write-Host "===== 新 PATH ====="
Write-Host $newValue
Write-Host "==================="
Write-Host ""
Write-Host "注意：已经打开的终端不会自动生效。请【新开】一个 PowerShell 再验证："
Write-Host "      node -v ; pnpm -v"
