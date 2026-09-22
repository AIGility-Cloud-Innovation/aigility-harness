# feishu-oauth-login.ps1 — 一次性用户授权，拿到 user_access_token / refresh_token
# 用法：pwsh -File .\feishu\oauth-login.ps1
# 结果保存到 feishu\user_token.local.json（0600 语义，勿外传）

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Web

$cred = Get-Content "$PSScriptRoot\app.local.json" -Raw | ConvertFrom-Json
$redirectUri = "http://localhost:18080/callback"
$scopes = "task:task:read task:task:write"   # 注意：空格分隔，逗号会报 20043

# 1. 生成授权链接
$authUrl = "https://accounts.feishu.cn/open-apis/authen/v1/authorize" +
    "?app_id=$($cred.app_id)" +
    "&redirect_uri=$([uri]::EscapeDataString($redirectUri))" +
    "&scope=$([uri]::EscapeDataString($scopes))" +
    "&state=$([guid]::NewGuid().ToString('N'))"
Write-Host "正在打开浏览器进行授权..."
Write-Host $authUrl
Start-Process $authUrl

# 2. 本地监听，接住回调 code（TcpListener 实现最小 HTTP 接收）
Write-Host "listener mode: $($ExecutionContext.SessionState.LanguageMode)"
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 18080)
Write-Host "listener type: $($listener.GetType().FullName)"
$listener.Start()
$code = $null
try {
    while (-not $code) {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        $buf = New-Object byte[] 8192
        $n = $stream.Read($buf, 0, $buf.Length)
        $reqLine = [Text.Encoding]::UTF8.GetString($buf, 0, $n) -split "`r`n" | Select-Object -First 1
        $client.Close()
        if ($reqLine -match "GET /callback\?(\S+)") {
            $q = [System.Web.HttpUtility]::ParseQueryString($matches[1])
            if ($q["code"]) { $code = $q["code"] }
        }
    }
} finally { $listener.Stop() }
Write-Host "已拿到授权 code，正在换取 token..."

# 3. 换取 user_access_token
$resp = Invoke-RestMethod -Method Post -Uri "https://open.feishu.cn/open-apis/authen/v2/oauth/token" `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        grant_type = "authorization_code"
        client_id = $cred.app_id
        client_secret = $cred.app_secret
        code = $code
        redirect_uri = $redirectUri
    } | ConvertTo-Json)

if (-not $resp.access_token) {
    throw "换取 token 失败: $($resp | ConvertTo-Json -Depth 5)"
}

# 4. 落盘
$out = [ordered]@{
    access_token  = $resp.access_token
    refresh_token = $resp.refresh_token
    expires_at    = (Get-Date).AddSeconds($resp.expires_in - 60).ToString("o")
    scope         = $resp.scope
}
$f = "$PSScriptRoot\user_token.local.json"
$out | ConvertTo-Json | Set-Content $f -Encoding UTF8
Write-Host "user_access_token 已保存到 $f"
Write-Host "scope: $($resp.scope)"
