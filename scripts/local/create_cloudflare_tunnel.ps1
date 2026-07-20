param(
    [Parameter(Mandatory = $true)]
    [string]$Hostname,
    [string]$TunnelName = "shareguard-local"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    $Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}
if (-not (Test-Path -LiteralPath $Cloudflared)) {
    throw "cloudflared is not installed."
}
if ($Hostname -notmatch "^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$") {
    throw "Hostname must be a valid fully qualified domain name."
}
$Certificate = Join-Path $HOME ".cloudflared\cert.pem"
if (-not (Test-Path -LiteralPath $Certificate)) {
    throw "Cloudflare authorization is missing. Run cloudflare_login.ps1 first."
}

$Existing = @(& $Cloudflared tunnel list --output json | ConvertFrom-Json) |
    Where-Object { $_.name -eq $TunnelName } |
    Select-Object -First 1
if (-not $Existing) {
    & $Cloudflared tunnel create $TunnelName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create Cloudflare Tunnel."
    }
    $Existing = @(& $Cloudflared tunnel list --output json | ConvertFrom-Json) |
        Where-Object { $_.name -eq $TunnelName } |
        Select-Object -First 1
}
if (-not $Existing) {
    throw "Cloudflare Tunnel was not found after creation."
}

$Credential = Join-Path $HOME ".cloudflared\$($Existing.id).json"
if (-not (Test-Path -LiteralPath $Credential)) {
    throw "Cloudflare Tunnel credential file is missing."
}
$Secrets = Join-Path $Root "secrets"
$Config = Join-Path $Secrets "cloudflared-config.yml"
New-Item -ItemType Directory -Force -Path $Secrets | Out-Null
@"
tunnel: $($Existing.id)
credentials-file: $Credential

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:7860
    originRequest:
      connectTimeout: 10s
  - service: http_status:404
"@ | Set-Content -LiteralPath $Config -Encoding ascii

@{
    tunnel_id = [string]$Existing.id
    tunnel_name = $TunnelName
    hostname = $Hostname.ToLowerInvariant()
    config = $Config
    dns_routed = $false
} | ConvertTo-Json | Set-Content `
    -LiteralPath (Join-Path $Secrets "cloudflared-state.json") `
    -Encoding ascii

Write-Output "Tunnel configuration created without publishing DNS."
Write-Output "Create the Cloudflare Access application for $Hostname before continuing."
