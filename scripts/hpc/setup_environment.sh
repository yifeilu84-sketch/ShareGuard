#!/bin/bash
# =============================================================================
# ShareGuard HPC Environment Setup for CityUHK Burgundy Cluster
# =============================================================================
# Usage:
#   bash scripts/hpc/setup_environment.sh          # Full setup (interactive)
#   bash scripts/hpc/setup_environment.sh --check   # Only check, don't install
#
# What this script does:
#   1. Validates HPC environment (modules, disk space)
#   2. Loads anaconda3 and cuda modules
#   3. Creates conda env 'shareguard' with Python 3.10
#   4. Installs PyTorch 2.1 + CUDA 12.1
#   5. Installs all ShareGuard dependencies
#   6. Installs ShareGuard as editable package
#   7. Verifies the installation
# =============================================================================

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
CONDA_ENV_NAME="shareguard"
PYTHON_VERSION="3.10"
PYTORCH_VERSION="2.1.0"
CUDA_VERSION="cu121"
PROJECT_DIR="${HOME}/ShareGuard"
CONDA_ENVS_DIR="${HOME}/.conda/envs"  # home has ~50GB, conda env ~5-8GB

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Pre-flight checks ──────────────────────────────────────────────────────
echo "============================================"
echo " ShareGuard HPC Environment Setup"
echo " CityUHK Burgundy Cluster"
echo " $(date)"
echo "============================================"
echo ""

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
    CHECK_ONLY=true
    log_info "Check-only mode (--check)"
fi

# Verify we're on the HPC
if ! command -v module &>/dev/null; then
    log_warn "'module' command not found. Are you on the Burgundy cluster?"
    log_warn "Continuing anyway (may work on other HPC systems)..."
fi

# Verify project directory
if [[ ! -d "$PROJECT_DIR" ]]; then
    log_err "ShareGuard project not found at $PROJECT_DIR"
    log_err "Upload your code first:"
    log_err "  scp -r /path/to/ShareGuard <user>@burgundy.hpc.cityu.edu.hk:~/"
    exit 1
fi

# Check requirements.txt
if [[ ! -f "$PROJECT_DIR/requirements.txt" ]]; then
    log_err "requirements.txt not found in $PROJECT_DIR"
    exit 1
fi

# ─── Step 1: Disk space check ───────────────────────────────────────────────
log_info "[1/7] Checking disk space..."

HOME_AVAIL=$(df -BG "$HOME" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
log_info "  Home directory: ${HOME_AVAIL}GB available (need ~10GB for conda env)"

if [[ "$HOME_AVAIL" -lt 10 ]]; then
    log_err "Insufficient home space. Need at least 10GB, have ${HOME_AVAIL}GB."
    log_err "Clean up files or use: conda config --append envs_dirs <other_path>"
    if [[ "$CHECK_ONLY" == true ]]; then
        log_err "FAIL: Disk space check failed"
    else
        exit 1
    fi
else
    log_ok "  Home: ${HOME_AVAIL}GB available"
fi

# Check scratch
SCRATCH_DIR="${SCRATCH:-}"
if [[ -n "$SCRATCH_DIR" && -d "$SCRATCH_DIR" ]]; then
    SCRATCH_AVAIL=$(df -BG "$SCRATCH_DIR" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    log_ok "  Scratch: ${SCRATCH_AVAIL}GB available at $SCRATCH_DIR"
else
    log_warn "  Scratch directory not set or not found. Data will go to \$HOME/scratch"
    SCRATCH_DIR="$HOME/scratch"
fi

if [[ "$CHECK_ONLY" == true ]]; then
    echo ""
    log_info "Check-only mode complete."
    exit 0
fi

# ─── Step 2: Load modules ───────────────────────────────────────────────────
log_info "[2/7] Loading HPC modules..."

module purge 2>/dev/null || true

# Load anaconda
if module load anaconda3/2024.06 2>/dev/null; then
    log_ok "  Loaded anaconda3/2024.06"
elif module load anaconda3/2023.09 2>/dev/null; then
    log_ok "  Loaded anaconda3/2023.09"
elif module load anaconda3 2>/dev/null; then
    log_ok "  Loaded anaconda3 (default)"
else
    log_warn "  No anaconda module found. Checking for system conda..."
    if ! command -v conda &>/dev/null; then
        log_err "  conda not found. Install Miniconda first:"
        log_err "    wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh"
        log_err "    bash Miniconda3-latest-Linux-x86_64.sh -b -p \$HOME/miniconda3"
        exit 1
    fi
fi

# Load CUDA
if module load cuda/12.1 2>/dev/null; then
    log_ok "  Loaded cuda/12.1"
elif module load cuda/12.0 2>/dev/null; then
    log_ok "  Loaded cuda/12.0"
elif module load cuda 2>/dev/null; then
    log_ok "  Loaded cuda (default)"
else
    log_warn "  No cuda module found. Will rely on PyTorch bundled CUDA runtime."
fi

# Initialize conda for this shell session
eval "$(conda shell.bash hook 2>/dev/null)" || {
    source "$(conda info --base)/etc/profile.d/conda.sh" 2>/dev/null || {
        log_err "Cannot initialize conda. Run: conda init bash && source ~/.bashrc"
        exit 1
    }
}

# ─── Step 3: Create conda environment ───────────────────────────────────────
log_info "[3/7] Setting up conda environment '${CONDA_ENV_NAME}'..."

if conda env list | grep -q "^${CONDA_ENV_NAME} "; then
    log_warn "  Environment '${CONDA_ENV_NAME}' already exists."
    read -p "  Recreate it? (y/N): " -n 1 -r REPLY
    echo
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        log_info "  Removing existing environment..."
        conda deactivate 2>/dev/null || true
        conda env remove -n "$CONDA_ENV_NAME" -y
        log_info "  Creating fresh environment..."
        conda create -n "$CONDA_ENV_NAME" python="$PYTHON_VERSION" -y
    else
        log_info "  Keeping existing environment."
    fi
else
    log_info "  Creating new environment '${CONDA_ENV_NAME}' with Python ${PYTHON_VERSION}..."
    conda create -n "$CONDA_ENV_NAME" python="$PYTHON_VERSION" -y
fi

conda activate "$CONDA_ENV_NAME"
log_ok "  Activated '${CONDA_ENV_NAME}' (Python $(python --version 2>&1 | cut -d' ' -f2))"

# ─── Step 4: Install PyTorch ────────────────────────────────────────────────
log_info "[4/7] Installing PyTorch ${PYTORCH_VERSION} with CUDA ${CUDA_VERSION}..."

pip install --upgrade pip setuptools wheel

pip install \
    "torch==${PYTORCH_VERSION}" \
    "torchvision==0.16.0" \
    --index-url "https://download.pytorch.org/whl/${CUDA_VERSION}"

# Verify PyTorch + CUDA
TORCH_VER=$(python -c "import torch; print(torch.__version__)" 2>/dev/null || echo "FAILED")
CUDA_OK=$(python -c "import torch; print('YES' if torch.cuda.is_available() else 'NO')" 2>/dev/null || echo "FAILED")

if [[ "$CUDA_OK" == "YES" ]]; then
    GPU_NAME=$(python -c "import torch; print(torch.cuda.get_device_name(0))" 2>/dev/null || echo "unknown")
    log_ok "  PyTorch ${TORCH_VER} installed, CUDA available: ${GPU_NAME}"
else
    log_warn "  PyTorch ${TORCH_VER} installed, but CUDA NOT available."
    log_warn "  This is OK for CPU-only jobs. GPU jobs will need CUDA-capable nodes."
fi

# ─── Step 5: Install dependencies ───────────────────────────────────────────
log_info "[5/7] Installing ShareGuard dependencies..."

cd "$PROJECT_DIR"
pip install -r requirements.txt

log_ok "  All dependencies installed"

# ─── Step 6: Install ShareGuard package ─────────────────────────────────────
log_info "[6/7] Installing ShareGuard as editable package..."

pip install -e .

log_ok "  ShareGuard installed in editable mode"

# ─── Step 7: Verify installation ────────────────────────────────────────────
log_info "[7/7] Verifying installation..."

python -c "
import sys
print(f'Python:     {sys.version}')

import torch
print(f'PyTorch:    {torch.__version__}')
print(f'CUDA avail: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'GPU:        {torch.cuda.get_device_name(0)}')
    print(f'CUDA ver:   {torch.version.cuda}')

import torchvision
print(f'TorchVision:{torchvision.__version__}')

import timm
print(f'timm:       {timm.__version__}')

import sklearn
print(f'scikit-learn:{sklearn.__version__}')

import pandas
print(f'pandas:     {pandas.__version__}')

import numpy
print(f'numpy:      {numpy.__version__}')

import cv2
print(f'OpenCV:     {cv2.__version__}')

import albumentations
print(f'albument:   {albumentations.__version__}')

try:
    import shareguard
    print(f'ShareGuard: {shareguard.__version__}')
except Exception as e:
    print(f'ShareGuard: FAILED ({e})')
    sys.exit(1)

print()
print('All packages verified successfully.')
"

echo ""
echo "============================================"
echo " Environment Setup Complete"
echo "============================================"
echo ""
echo " Activate with:  conda activate ${CONDA_ENV_NAME}"
echo " Project dir:    ${PROJECT_DIR}"
echo " Scratch dir:    ${SCRATCH_DIR}"
echo ""
echo " Next steps:"
echo "   1. Download data:  bash scripts/hpc/download_genimage.sh"
echo "   2. Validate setup: bash scripts/hpc/validate_setup.sh"
echo "   3. Run pilot:      sbatch scripts/hpc/run_pilot.slurm"
echo "============================================"
