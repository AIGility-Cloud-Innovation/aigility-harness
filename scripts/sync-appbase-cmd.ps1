# Regenerate examples/appbase/start-appbase.cmd from the fixed .cmd.example template,
# preserving the 3 secret values you filled in (they are read from the old .cmd and
# written straight through - they are never printed to the console or the log).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\sync-appbase-cmd.ps1
#
# What it fixes in start-appbase.cmd:
#   - removes "chcp 65001" (codepage switch mid-run can swallow script output)
#   - psql is located automatically instead of a hardcoded version list
#     (old list missed any PostgreSQL version not enumerated, e.g. 18)
#   - PGPASSWORD is set BEFORE the first psql call (old code probed unauthenticated)
#   - PATH prepending moved out of the for-block (parse-time %PATH% expansion)
#   - "Cannot connect to PostgreSQL" is now reported explicitly instead of a bare pause
$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$dir     = Join-Path $repo 'examples\appbase'
$oldPath = Join-Path $dir 'start-appbase.cmd'
$tplPath = Join-Path $dir 'start-appbase.cmd.example'
$bakPath = Join-Path $dir 'start-appbase.cmd.bak'

$keys = @('set APPBASE_PG_PASSWORD=', 'set BIGMODEL_API_KEY=', 'set APPBASE_GATEWAY_KEY=')

if (-not (Test-Path -LiteralPath $oldPath)) { Write-Host "not found: $oldPath"; exit 1 }
if (-not (Test-Path -LiteralPath $tplPath)) { Write-Host "not found: $tplPath"; exit 1 }

$oldLines = [System.IO.File]::ReadAllLines($oldPath)
$tplLines = [System.IO.File]::ReadAllLines($tplPath)

$vals = @{}
foreach ($k in $keys) {
  $hit = $oldLines | Where-Object { $_.StartsWith($k) } | Select-Object -First 1
  if (-not $hit) { Write-Host "ABORT - not found in .cmd: $k"; exit 1 }
  $vals[$k] = $hit.Substring($k.Length)
  Write-Host ("keep  {0}  (value length {1})" -f $k, $vals[$k].Length)
}

if (Test-Path -LiteralPath $bakPath) { Write-Host "backup already exists, left untouched: $bakPath" }
else { Copy-Item -LiteralPath $oldPath -Destination $bakPath -Force; Write-Host "backup: $bakPath" }

$out = New-Object System.Collections.Generic.List[string]
foreach ($l in $tplLines) {
  $k = $keys | Where-Object { $l.StartsWith($_) } | Select-Object -First 1
  if ($k) { $out.Add($k + $vals[$k]) } else { $out.Add($l) }
}

# CRLF (cmd.exe native) + UTF-8 WITHOUT BOM (a BOM would corrupt the first line).
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($oldPath, (($out -join "`r`n") + "`r`n"), $enc)
Write-Host ("written: {0} ({1} lines)" -f $oldPath, $out.Count)

$new = [System.IO.File]::ReadAllText($oldPath)
$n = 0
if (-not $new.Contains('APPBASE_PSQL_BIN'))      { Write-Host 'CHECK FAILED: new psql discovery missing'; $n++ }
if (-not $new.Contains(':psql_missing'))          { Write-Host 'CHECK FAILED: psql_missing label missing'; $n++ }
if ($new.Contains('chcp 65001'))                  { Write-Host 'CHECK FAILED: chcp 65001 still present'; $n++ }
if ($new.Contains('PSQL_FOUND'))                  { Write-Host 'CHECK FAILED: old probe still present'; $n++ }
foreach ($k in $keys) {
  if (-not $new.Contains($k + $vals[$k])) { Write-Host "CHECK FAILED: secret lost: $k"; $n++ }
}
if ($n -eq 0) { Write-Host 'all checks passed - start-appbase.cmd is now in sync with the template' }
exit $n
