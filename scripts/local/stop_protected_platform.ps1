$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$PidFile = Join-Path $Root ".shareguard-runtime\pids.json"

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Output "ShareGuard is not running."
    exit 0
}

$State = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
foreach ($ProcessId in @($State.cloudflared_pid, $State.gateway_pid, $State.inference_pid)) {
    if (-not $ProcessId) {
        continue
    }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $Process) {
        continue
    }
    $IsGateway = $Process.CommandLine -like "*run_gateway.ps1*"
    $IsInference = $Process.CommandLine -like "*run_private_inference.ps1*"
    $IsNamedTunnel = $Process.CommandLine -like "*cloudflared*tunnel*run*"
    $IsQuickTunnelCommand = $Process.CommandLine -like "*cloudflared*tunnel*--url*"
    $IsQuickTunnelTarget = $Process.CommandLine -like "*127.0.0.1:7860*"
    $IsQuickTunnel = $IsQuickTunnelCommand -and $IsQuickTunnelTarget
    $IsTunnel = $IsNamedTunnel -or $IsQuickTunnel
    if (-not ($IsGateway -or $IsInference -or $IsTunnel)) {
        throw "Refusing to stop an unexpected process with PID $ProcessId."
    }
    & taskkill.exe /PID $ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -notin 0, 128) {
        throw "Failed to stop ShareGuard process tree $ProcessId."
    }
}

Remove-Item -LiteralPath $PidFile -Force
Write-Output "ShareGuard local stack stopped."
