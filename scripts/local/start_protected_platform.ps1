param(
    [switch]$AccessProtected,
    [switch]$PasswordProtected,
    [switch]$Offline,
    [string]$AllowedOrigin = ""
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Runtime = Join-Path $Root ".shareguard-runtime"
$Secrets = Join-Path $Root "secrets"
$SecretFile = Join-Path $Secrets "local-serving.json"
$PidFile = Join-Path $Runtime "pids.json"

New-Item -ItemType Directory -Force -Path $Runtime, $Secrets | Out-Null
if (Test-Path -LiteralPath $PidFile) {
    throw "A ShareGuard stack PID file already exists. Run stop_protected_platform.ps1 first."
}
function New-UrlSafeSecret([int]$ByteCount) {
    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    } finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

if (-not (Test-Path -LiteralPath $SecretFile)) {
    @{
        internal_api_token = (New-UrlSafeSecret 48)
        demo_username = "shareguard-demo"
        demo_password = (New-UrlSafeSecret 24)
        created_at = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $SecretFile -Encoding ascii
} else {
    $ExistingSecret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
    $SecretChanged = $false
    if (-not $ExistingSecret.demo_username) {
        $ExistingSecret | Add-Member -NotePropertyName demo_username -NotePropertyValue "shareguard-demo"
        $SecretChanged = $true
    }
    if (-not $ExistingSecret.demo_password) {
        $ExistingSecret | Add-Member -NotePropertyName demo_password -NotePropertyValue (New-UrlSafeSecret 24)
        $SecretChanged = $true
    }
    if ($SecretChanged) {
        $ExistingSecret | ConvertTo-Json | Set-Content -LiteralPath $SecretFile -Encoding ascii
    }
}

$InferenceScript = Join-Path $PSScriptRoot "run_private_inference.ps1"
$GatewayScript = Join-Path $PSScriptRoot "run_gateway.ps1"
$InferenceArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $InferenceScript
)
if ($Offline) {
    $InferenceArgs += "-Offline"
}

$Inference = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $InferenceArgs `
    -RedirectStandardOutput (Join-Path $Runtime "inference.stdout.log") `
    -RedirectStandardError (Join-Path $Runtime "inference.stderr.log") `
    -WindowStyle Hidden `
    -PassThru

@{
    inference_pid = $Inference.Id
    gateway_pid = $null
    access_protected = $AccessProtected.IsPresent
    password_protected = $PasswordProtected.IsPresent
    allowed_origin = $AllowedOrigin.Trim().TrimEnd("/")
    started_at = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding ascii

$InferenceReady = $false
for ($attempt = 0; $attempt -lt 300; $attempt++) {
    Start-Sleep -Seconds 2
    if ($Inference.HasExited) {
        throw "Private inference exited during startup. Check .shareguard-runtime logs."
    }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:7861/v1/ready" -TimeoutSec 3
        if ($health.status -eq "ready") {
            $InferenceReady = $true
            break
        }
    } catch {
    }
}
if (-not $InferenceReady) {
    throw "Private inference did not become ready within 10 minutes."
}

$GatewayArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $GatewayScript
)
if ($AccessProtected) {
    $GatewayArgs += "-AccessProtected"
}
if ($PasswordProtected) {
    $GatewayArgs += "-PasswordProtected"
}
if ($AllowedOrigin) {
    $GatewayArgs += @("-AllowedOrigin", $AllowedOrigin.Trim().TrimEnd("/"))
}
$Gateway = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList $GatewayArgs `
    -RedirectStandardOutput (Join-Path $Runtime "gateway.stdout.log") `
    -RedirectStandardError (Join-Path $Runtime "gateway.stderr.log") `
    -WindowStyle Hidden `
    -PassThru

$GatewayReady = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    if ($Gateway.HasExited) {
        throw "Gateway exited during startup. Check .shareguard-runtime logs."
    }
    try {
        $Headers = @{}
        if ($PasswordProtected) {
            $Secret = Get-Content -LiteralPath $SecretFile -Raw | ConvertFrom-Json
            $BasicValue = [Convert]::ToBase64String(
                [Text.Encoding]::UTF8.GetBytes(
                    "$([string]$Secret.demo_username):$([string]$Secret.demo_password)"
                )
            )
            $Headers.Authorization = "Basic $BasicValue"
        }
        $health = Invoke-RestMethod `
            -Uri "http://127.0.0.1:7860/v1/ready" `
            -Headers $Headers `
            -TimeoutSec 3
        if ($health.status -eq "ready") {
            $GatewayReady = $true
            break
        }
    } catch {
    }
}
if (-not $GatewayReady) {
    throw "Gateway did not become ready."
}

@{
    inference_pid = $Inference.Id
    gateway_pid = $Gateway.Id
    access_protected = $AccessProtected.IsPresent
    password_protected = $PasswordProtected.IsPresent
    allowed_origin = $AllowedOrigin.Trim().TrimEnd("/")
    started_at = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding ascii

Write-Output "ShareGuard is ready at http://127.0.0.1:7860"
