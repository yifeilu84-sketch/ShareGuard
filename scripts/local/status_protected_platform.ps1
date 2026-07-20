$ErrorActionPreference = "SilentlyContinue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$PidFile = Join-Path $Root ".shareguard-runtime\pids.json"
$SecretFile = Join-Path $Root "secrets\local-serving.json"
$State = $null
$Headers = @{}
if (Test-Path -LiteralPath $PidFile) {
    $State = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
}
$HasPasswordProtection = $State -and $State.password_protected
$HasSecretFile = Test-Path -LiteralPath $SecretFile
if ($HasPasswordProtection -and $HasSecretFile) {
    $Secret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
    $BasicValue = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes(
            "$([string]$Secret.demo_username):$([string]$Secret.demo_password)"
        )
    )
    $Headers.Authorization = "Basic $BasicValue"
}

foreach ($Target in @(
    @{ Name = "Gateway"; Uri = "http://127.0.0.1:7860/v1/ready"; Headers = $Headers },
    @{ Name = "Private inference"; Uri = "http://127.0.0.1:7861/v1/ready"; Headers = @{} }
)) {
    try {
        $Response = Invoke-RestMethod -Uri $Target.Uri -Headers $Target.Headers -TimeoutSec 3
        Write-Output "$($Target.Name): $($Response.status)"
    } catch {
        Write-Output "$($Target.Name): offline"
    }
}

if ($State) {
    if ($State.cloudflared_pid) {
        $Tunnel = Get-Process -Id $State.cloudflared_pid -ErrorAction SilentlyContinue
        Write-Output "Cloudflare Tunnel: $(if ($Tunnel) { 'running' } else { 'offline' })"
    }
    if ($State.quick_tunnel_url) {
        Write-Output "Demo URL: $($State.quick_tunnel_url)"
    }
}
