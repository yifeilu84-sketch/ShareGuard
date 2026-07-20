param(
    [switch]$Offline
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Python = Join-Path $Root ".venv-serving\Scripts\python.exe"
$SecretFile = Join-Path $Root "secrets\local-serving.json"
$Bundle = Join-Path $Root "model_artifacts\shareguard-noisyshare-fusion-v1-safe.tar.gz"
$ChecksumFile = "$Bundle.sha256"
$Cache = Join-Path $Root ".shareguard-cache"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Serving environment is missing. Run bootstrap_serving.ps1 first."
}
if (-not (Test-Path -LiteralPath $SecretFile)) {
    throw "Local serving secret is missing. Run start_protected_platform.ps1."
}
if (-not (Test-Path -LiteralPath $Bundle)) {
    throw "Safe model bundle is missing."
}
if (-not (Test-Path -LiteralPath $ChecksumFile)) {
    throw "Safe model checksum file is missing."
}

$Secret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
$Expected = ((Get-Content -LiteralPath $ChecksumFile -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
$Actual = (Get-FileHash -LiteralPath $Bundle -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Expected -ne $Actual) {
    throw "Safe model bundle SHA-256 mismatch."
}

New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$env:SHAREGUARD_MODE = "production"
$env:SHAREGUARD_BACKEND = "fusion-bundle"
$env:SHAREGUARD_HOST = "127.0.0.1"
$env:SHAREGUARD_DEVICE = "cuda"
$env:SHAREGUARD_API_TOKEN = [string]$Secret.internal_api_token
$env:SHAREGUARD_BUNDLE_SHA256 = $Actual
$env:SHAREGUARD_MODEL_VERSION = "shareguard-private-v1-safe"
$env:SHAREGUARD_MODEL_CACHE = (Join-Path $Cache "models")
$env:SHAREGUARD_INCLUDE_PROPAGATION_VIEWS = "false"
$env:SHAREGUARD_PUBLIC_SCORE_DECIMALS = "4"
$env:SHAREGUARD_MAX_INFERENCE_CONCURRENCY = "1"
$env:SHAREGUARD_MAX_WAITING_REQUESTS = "2"
$env:SHAREGUARD_MAX_HTTP_WORKERS = "4"
$env:BUNDLE = $Bundle
$env:PORT = "7861"
$env:HF_HOME = (Join-Path $Cache "huggingface")
$env:TORCH_HOME = (Join-Path $Cache "torch")
$env:XDG_CACHE_HOME = $Cache
$env:HF_HUB_DISABLE_TELEMETRY = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:DO_NOT_TRACK = "1"
$env:PYTHONUNBUFFERED = "1"
if ($Offline) {
    $env:HF_HUB_OFFLINE = "1"
    $env:TRANSFORMERS_OFFLINE = "1"
    & $Python (Join-Path $Root "scripts\verify_backbone_cache.py") `
        --hf-home $env:HF_HOME `
        --lock (Join-Path $Root "deploy\backbone-lock.json")
    if ($LASTEXITCODE -ne 0) {
        throw "Locked backbone cache verification failed."
    }
} else {
    Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
    Remove-Item Env:TRANSFORMERS_OFFLINE -ErrorAction SilentlyContinue
}

& $Python -m shareguard.platform.app
exit $LASTEXITCODE
