param(
    [switch]$AccessProtected,
    [switch]$PasswordProtected
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = Join-Path $Root ".venv-serving\Scripts\python.exe"
$SecretFile = Join-Path $Root "secrets\local-serving.json"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Serving environment is missing. Run bootstrap_serving.ps1 first."
}
if (-not (Test-Path -LiteralPath $SecretFile)) {
    throw "Local serving secret is missing. Run start_protected_platform.ps1."
}

$Secret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
$env:SHAREGUARD_MODE = $(if ($AccessProtected -or $PasswordProtected) { "production" } else { "pilot" })
$env:SHAREGUARD_BACKEND = "remote"
$env:SHAREGUARD_HOST = "127.0.0.1"
$env:SHAREGUARD_REQUIRE_ACCESS_IDENTITY = $AccessProtected.IsPresent.ToString().ToLowerInvariant()
$env:SHAREGUARD_RATE_LIMIT_PER_MINUTE = "3"
$env:SHAREGUARD_DAILY_QUOTA = "30"
$env:SHAREGUARD_PUBLIC_SCORE_DECIMALS = "2"
$env:SHAREGUARD_INCLUDE_PROPAGATION_VIEWS = "false"
$env:SHAREGUARD_MAX_UPLOAD_BYTES = "10485760"
$env:SHAREGUARD_MAX_IMAGE_PIXELS = "25000000"
$env:SHAREGUARD_MAX_INFERENCE_CONCURRENCY = "1"
$env:SHAREGUARD_MAX_WAITING_REQUESTS = "4"
$env:SHAREGUARD_MAX_HTTP_WORKERS = "8"
$env:SHAREGUARD_MODEL_VERSION = "shareguard-private-v1-safe"
$env:REMOTE_URL = "http://127.0.0.1:7861/api/analyze"
$env:REMOTE_TOKEN = [string]$Secret.internal_api_token
$env:PORT = "7860"
$env:PYTHONUNBUFFERED = "1"
Remove-Item Env:SHAREGUARD_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:SHAREGUARD_HTTP_BASIC_USERNAME -ErrorAction SilentlyContinue
Remove-Item Env:SHAREGUARD_HTTP_BASIC_PASSWORD -ErrorAction SilentlyContinue
if ($PasswordProtected) {
    if (-not $Secret.demo_username -or -not $Secret.demo_password) {
        throw "Demo credentials are missing from the local secret file."
    }
    $env:SHAREGUARD_HTTP_BASIC_USERNAME = [string]$Secret.demo_username
    $env:SHAREGUARD_HTTP_BASIC_PASSWORD = [string]$Secret.demo_password
}

& $Python -m shareguard.platform.app
exit $LASTEXITCODE
