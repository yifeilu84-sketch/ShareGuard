param(
    [Parameter(Mandatory = $true)]
    [switch]$AccessPolicyConfirmed
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    $Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}
$StateFile = Join-Path $Root "secrets\cloudflared-state.json"
$PidFile = Join-Path $Root ".shareguard-runtime\pids.json"
if (-not $AccessPolicyConfirmed) {
    throw "Access policy confirmation is required."
}
if (-not (Test-Path -LiteralPath $StateFile)) {
    throw "Cloudflare tunnel state is missing."
}
if (-not (Test-Path -LiteralPath $PidFile)) {
    throw "ShareGuard local stack is not running."
}

$State = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
$Processes = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
if (-not $Processes.access_protected) {
    throw "Restart ShareGuard with -AccessProtected before publishing."
}
if (-not $State.dns_routed) {
    & $Cloudflared tunnel route dns $State.tunnel_name $State.hostname
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to route the Cloudflare hostname."
    }
    $State.dns_routed = $true
    $State | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding ascii
}

$Runtime = Join-Path $Root ".shareguard-runtime"
$Tunnel = Start-Process `
    -FilePath $Cloudflared `
    -ArgumentList @("tunnel", "--config", [string]$State.config, "run") `
    -RedirectStandardOutput (Join-Path $Runtime "cloudflared.stdout.log") `
    -RedirectStandardError (Join-Path $Runtime "cloudflared.stderr.log") `
    -WindowStyle Hidden `
    -PassThru

$Processes | Add-Member -NotePropertyName cloudflared_pid -NotePropertyValue $Tunnel.Id -Force
$Processes | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding ascii
Write-Output "Cloudflare Tunnel started for https://$($State.hostname)"
