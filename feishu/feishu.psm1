# feishu.psm1 — 直接调用飞书 Open API 的最小辅助模块（无需安装任何 agent）
# 用法：
#   Import-Module .\feishu.psm1
#   $env:FEISHU_APP_ID = "cli_xxx"; $env:FEISHU_APP_SECRET = "xxx"
#   Get-FeishuToken
#   Invoke-Feishu -Method GET -Path "/open-apis/task/v2/tasks" -Query @{ page_size = 50 }
#   Invoke-Feishu -Method POST -Path "/open-apis/task/v2/tasks" -Body @{ summary = "测试任务" }

$script:BaseUrl = "https://open.feishu.cn"
$script:CachedToken = $null
$script:TokenExpireAt = [datetime]::MinValue

function Get-FeishuToken {
    <# 获取 tenant_access_token，带缓存（提前 60s 过期刷新） #>
    if ($script:CachedToken -and (Get-Date) -lt $script:TokenExpireAt) {
        return $script:CachedToken
    }
    $appId = $env:FEISHU_APP_ID
    $secret = $env:FEISHU_APP_SECRET
    if (-not $appId -or -not $secret) {
        throw "请先设置 `$env:FEISHU_APP_ID 和 `$env:FEISHU_APP_SECRET"
    }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/open-apis/auth/v3/tenant_access_token/internal" `
        -ContentType "application/json; charset=utf-8" `
        -Body (@{ app_id = $appId; app_secret = $secret } | ConvertTo-Json)
    if ($resp.code -ne 0) { throw "获取 token 失败: $($resp | ConvertTo-Json -Depth 5)" }
    $script:CachedToken = $resp.tenant_access_token
    $script:TokenExpireAt = (Get-Date).AddSeconds($resp.expire - 60)
    return $script:CachedToken
}

function Invoke-Feishu {
    <#
        通用飞书 API 调用。
        -Path   例: /open-apis/task/v2/tasks
        -Query  hashtable，拼到 URL 查询串
        -Body   hashtable，作为 JSON body（自动转 UTF-8）
    #>
    param(
        [string]$Method = "GET",
        [Parameter(Mandatory)][string]$Path,
        [hashtable]$Query,
        $Body
    )
    $token = Get-FeishuToken
    $url = "$BaseUrl$Path"
    if ($Query) {
        $qs = ($Query.GetEnumerator() | ForEach-Object {
            "$([uri]::EscapeDataString([string]$_.Key))=$([uri]::EscapeDataString([string]$_.Value))"
        }) -join "&"
        $url = "$url`?$qs"
    }
    $headers = @{ Authorization = "Bearer $token" }
    $params = @{ Method = $Method; Uri = $url; Headers = $headers }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 10
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $params["ContentType"] = "application/json; charset=utf-8"
        $params["Body"] = $bytes
    }
    $resp = Invoke-RestMethod @params
    if ($resp.code -and $resp.code -ne 0) {
        throw "飞书 API 错误 code=$($resp.code) msg=$($resp.msg)"
    }
    return $resp.data
}

function Get-FeishuUserToken {
    <# 读取 oauth-login.ps1 保存的用户 token；过期则自动用 refresh_token 续期 #>
    $f = "$PSScriptRoot\user_token.local.json"
    if (-not (Test-Path $f)) { throw "未找到 $f，请先运行 feishu\oauth-login.ps1 完成授权" }
    $t = Get-Content $f -Raw | ConvertFrom-Json
    if ((Get-Date) -ge [datetime]$t.expires_at) {
        $cred = Get-Content "$PSScriptRoot\app.local.json" -Raw | ConvertFrom-Json
        $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/open-apis/authen/v2/oauth/token" `
            -ContentType "application/json; charset=utf-8" `
            -Body (@{
                grant_type = "refresh_token"
                client_id = $cred.app_id
                client_secret = $cred.app_secret
                refresh_token = $t.refresh_token
            } | ConvertTo-Json)
        if (-not $resp.access_token) { throw "刷新 token 失败: $($resp | ConvertTo-Json -Depth 5)" }
        $t = [pscustomobject]@{
            access_token = $resp.access_token
            refresh_token = $resp.refresh_token
            expires_at = (Get-Date).AddSeconds($resp.expires_in - 60).ToString("o")
            scope = $resp.scope
        }
        $t | ConvertTo-Json | Set-Content $f -Encoding UTF8
    }
    return $t.access_token
}

function Invoke-FeishuUser {
    <# 用户身份调用（任务 v2 等需要 user_access_token 的接口），参数同 Invoke-Feishu #>
    param(
        [string]$Method = "GET",
        [Parameter(Mandatory)][string]$Path,
        [hashtable]$Query,
        $Body
    )
    $token = Get-FeishuUserToken
    $url = "$BaseUrl$Path"
    if ($Query) {
        $qs = ($Query.GetEnumerator() | ForEach-Object {
            "$([uri]::EscapeDataString([string]$_.Key))=$([uri]::EscapeDataString([string]$_.Value))"
        }) -join "&"
        $url = "$url`?$qs"
    }
    $params = @{ Method = $Method; Uri = $url; Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 10
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $params["ContentType"] = "application/json; charset=utf-8"
        $params["Body"] = $bytes
    }
    $resp = Invoke-RestMethod @params
    if ($resp.code -and $resp.code -ne 0) {
        throw "飞书 API 错误 code=$($resp.code) msg=$($resp.msg)"
    }
    return $resp.data
}

# ---- 常用封装示例 ----

function Get-FeishuTasks {
    <# 任务 v2：列出任务（用户身份，需要 task:task:read） #>
    param([int]$PageSize = 50, [string]$PageToken)
    $q = @{ page_size = $PageSize; user_id_type = "open_id" }
    if ($PageToken) { $q.page_token = $PageToken }
    Invoke-FeishuUser -Method GET -Path "/open-apis/task/v2/tasks" -Query $q
}

function New-FeishuTask {
    <# 创建任务（用户身份，需要 task:task:write） #>
    param(
        [Parameter(Mandatory)][string]$Summary,
        [string]$Description,
        [string]$DueDate  # ISO8601, 如 2026-02-01T18:00:00+08:00
    )
    $body = @{ summary = $Summary }
    if ($Description) { $body.description = $Description }
    if ($DueDate) { $body.due = @{ is_all_day = $false; date = $DueDate } }
    Invoke-FeishuUser -Method POST -Path "/open-apis/task/v2/tasks" -Query @{ user_id_type = "open_id" } -Body $body
}

function Get-FeishuBitableRecords {
    <# 多维表格记录（需要 bitable:app 权限） #>
    param(
        [Parameter(Mandatory)][string]$AppToken,
        [Parameter(Mandatory)][string]$TableId,
        [int]$PageSize = 100
    )
    Invoke-Feishu -Method GET -Path "/open-apis/bitable/v1/apps/$AppToken/tables/$TableId/records" `
        -Query @{ page_size = $PageSize; page_type = "page" }
}

function Get-FeishuDriveFiles {
    <# 云空间根目录文件列表（需要 drive:drive） #>
    param([string]$FolderToken = "")
    $body = if ($FolderToken) { @{ folder_token = $FolderToken; order_by = "edited_time"; direction = "DESC" } } else { @{ order_by = "edited_time"; direction = "DESC" } }
    Invoke-Feishu -Method POST -Path "/open-apis/drive/v1/files/list" -Body $body
}

Export-ModuleMember -Function Get-FeishuToken, Get-FeishuUserToken, Invoke-Feishu, Invoke-FeishuUser, Get-FeishuTasks, New-FeishuTask, Get-FeishuBitableRecords, Get-FeishuDriveFiles
