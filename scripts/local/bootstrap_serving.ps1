param(
    [switch]$Recreate
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Venv = Join-Path $Root ".venv-serving"
$Python = Join-Path $Venv "Scripts\python.exe"

if ($Recreate -and (Test-Path -LiteralPath $Venv)) {
    $resolved = (Resolve-Path -LiteralPath $Venv).Path
    if ($resolved -ne (Join-Path $Root ".venv-serving")) {
        throw "Refusing to remove an unexpected virtual environment path."
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if (-not (Test-Path -LiteralPath $Python)) {
    & python -m venv --system-site-packages $Venv
}

& $Python -m pip install --no-deps `
    --index-url "https://download.pytorch.org/whl/nightly/cu128" `
    "torchvision==0.27.0.dev20260407+cu128"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install the CUDA-compatible torchvision build."
}

& $Python -m pip install -r (Join-Path $Root "requirements-serving-windows.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Failed to install serving dependencies."
}

& $Python -m pip install --no-deps -e $Root
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register the local ShareGuard package."
}

& $Python -c "import torch, timm, safetensors; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) {
    throw "CUDA serving environment validation failed."
}
