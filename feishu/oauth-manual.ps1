# feishu-oauth-manual.ps1 — 手动授权：打印授权链接；把跳转后的完整 URL 或 code 作为参数传入即可换取 token
# 步骤：
#   1. pwsh -File feishu\oauth-manual.ps1            # 只打印授权链接
#   2. 在浏览器打开链接并同意授权
#   3. 浏览器跳转到 http://localhost:18080/callback?code=xxx&state=... 会显示无法访问，属正常
#   4. 把地址栏完整 URL 复制下来，运行：pwsh -File feishu\oauth-manual.ps1 -CallbackUrl "<完整URL>"
param([string]$CallbackUrl)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cred = Get-Content "$PSScriptRoot\app.local.json" -Raw | ConvertFrom-Json
$redirectUri = "http://localhost:18080/callback"
$scopes = "task:task:read task:task:write"

if (-not $CallbackUrl) {
    $authUrl = "https://accounts.feishu.cn/open-apis/authen/v1/authorize" +
        "?app_id=$($cred.app_id)" +
        "&redirect_uri=$([uri]::EscapeDataString($redirectUri))" +
        "&scope=$([uri]::EscapeDataString($scopes))" +
        "&state=$([guid]::NewGuid().ToString('N'))"
    Write-Host "请在浏览器打开以下链接并同意授权："
    Write-Host $authUrl
    return
}

# 从回调 URL 或裸 code 提取 code
$code = $CallbackUrl
if ($CallbackUrl -match "[?&]code=([^&\s]+)") { $code = $matches[1] }

$resp = Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/authen/v2/oauth/token" `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        grant_type = "authorization_code"
        client_id = $cred.app_id
        client_secret = $cred.app_secret
        code = $code
        redirect_uri = $redirectUri
    } | ConvertTo-Json)

if (-not $resp.access_token) { throw "换取 token 失败: $($resp | ConvertTo-Json -Depth 5)" }

$out = [ordered]@{
    access_token  = $resp.access_token
    refresh_token = $resp.refresh_token
    expires_at    = (Get-Date).AddSeconds($resp.expires_in - 60).ToString("o")
    scope         = $resp.scope
}
$out | ConvertTo-Json | Set-Content "$PSScriptRoot\user_token.local.json" -Encoding UTF8
Write-Host "user_access_token 已保存到 user_token.local.json"
Write-Host "scope: $($resp.scope)"
