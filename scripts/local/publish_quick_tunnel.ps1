param(
    [int]$StartupTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Runtime = Join-Path $Root ".shareguard-runtime"
$Secrets = Join-Path $Root "secrets"
$PidFile = Join-Path $Runtime "pids.json"
$SecretFile = Join-Path $Secrets "local-serving.json"
$AccessFile = Join-Path $Secrets "quick-tunnel-access.txt"
$StdoutLog = Join-Path $Runtime "quick-tunnel.stdout.log"
$StderrLog = Join-Path $Runtime "quick-tunnel.stderr.log"
$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    $Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}

if (-not (Test-Path -LiteralPath $Cloudflared)) {
    throw "cloudflared is not installed."
}
if (-not (Test-Path -LiteralPath $PidFile)) {
    throw "ShareGuard is not running."
}
if (-not (Test-Path -LiteralPath $SecretFile)) {
    throw "ShareGuard demo credentials are missing."
}

$State = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
if (-not $State.password_protected) {
    throw "Restart ShareGuard with -PasswordProtected before publishing."
}
if ($State.cloudflared_pid) {
    $ExistingTunnel = Get-Process -Id $State.cloudflared_pid -ErrorAction SilentlyContinue
    if ($ExistingTunnel) {
        throw "A Cloudflare Tunnel process is already running."
    }
}

Remove-Item -LiteralPath $StdoutLog, $StderrLog -Force -ErrorAction SilentlyContinue
$Tunnel = Start-Process `
    -FilePath $Cloudflared `
    -ArgumentList @(
        "tunnel",
        "--no-autoupdate",
        "--url",
        "http://127.0.0.1:7860"
    ) `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -WindowStyle Hidden `
    -PassThru

$Url = $null
for ($attempt = 0; $attempt -lt ($StartupTimeoutSeconds * 2); $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($Tunnel.HasExited) {
        $ErrorText = Get-Content -LiteralPath $StderrLog -Raw -ErrorAction SilentlyContinue
        throw "Quick Tunnel exited during startup. $ErrorText"
    }
    $LogText = @(
        Get-Content -LiteralPath $StdoutLog -Raw -ErrorAction SilentlyContinue
        Get-Content -LiteralPath $StderrLog -Raw -ErrorAction SilentlyContinue
    ) -join "`n"
    $Match = [regex]::Match(
        $LogText,
        "https://[a-z0-9-]+\.trycloudflare\.com",
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if ($Match.Success) {
        $Url = $Match.Value.ToLowerInvariant()
        break
    }
}
if (-not $Url) {
    & taskkill.exe /PID $Tunnel.Id /T /F | Out-Null
    throw "Quick Tunnel did not provide a public URL within the timeout."
}

$State | Add-Member -NotePropertyName cloudflared_pid -NotePropertyValue $Tunnel.Id -Force
$State | Add-Member -NotePropertyName quick_tunnel_url -NotePropertyValue $Url -Force
$State | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding ascii

$Secret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
@(
    "ShareGuard private demo"
    "URL: $Url"
    "Username: $([string]$Secret.demo_username)"
    "Password: $([string]$Secret.demo_password)"
    ""
    "Keep these credentials private. Stop the local stack when the demo ends."
) | Set-Content -LiteralPath $AccessFile -Encoding utf8

Write-Output "ShareGuard Quick Tunnel is ready at $Url"
Write-Output "Private credentials: $AccessFile"
