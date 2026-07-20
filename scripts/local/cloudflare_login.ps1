$ErrorActionPreference = "Stop"
$Cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $Cloudflared) {
    $Cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
}
if (-not (Test-Path -LiteralPath $Cloudflared)) {
    throw "cloudflared is not installed."
}

& $Cloudflared tunnel login
exit $LASTEXITCODE
