#!/bin/bash
# =============================================================================
# ShareGuard HPC Setup Validation
# =============================================================================
# Usage:
#   bash scripts/hpc/validate_setup.sh           # Full validation
#   bash scripts/hpc/validate_setup.sh --quick    # Quick check (no GPU test)
#
# Checks performed:
#   1. HPC environment (modules, SLURM, partitions)
#   2. Conda environment and Python packages
#   3. CUDA and GPU availability
#   4. Project structure and code
#   5. Data availability and integrity
#   6. Disk space across all storage tiers
#   7. Network connectivity (for downloads)
#   8. End-to-end smoke test (optional)
# =============================================================================

set -uo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
PROJECT_DIR="${HOME}/ShareGuard"
SCRATCH_DIR="${SCRATCH:-${HOME}/scratch}"
CONDA_ENV="shareguard"

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

check_pass() { echo -e "  ${GREEN}PASS${NC}  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
check_warn() { echo -e "  ${YELLOW}WARN${NC}  $*"; WARN_COUNT=$((WARN_COUNT + 1)); }
check_fail() { echo -e "  ${RED}FAIL${NC}  $*"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
section()    { echo -e "\n${BOLD}── $* ──${NC}"; }

# ─── Parse args ─────────────────────────────────────────────────────────────
QUICK=false
for arg in "$@"; do
    case "$arg" in
        --quick) QUICK=true ;;
        --help|-h)
            echo "Usage: $0 [--quick|--help]"
            echo "  --quick   Skip GPU smoke test (faster)"
            echo "  --help    Show this help"
            exit 0
            ;;
    esac
done

echo "============================================"
echo " ShareGuard HPC Validation"
echo " $(date)"
echo " Host: $(hostname)"
echo "============================================"

# ═══════════════════════════════════════════════════════════════════════════════
section "1. HPC Environment"
# ═══════════════════════════════════════════════════════════════════════════════

# SLURM
if command -v sinfo &>/dev/null; then
    check_pass "SLURM is available"

    # Check partitions
    echo ""
    echo "  Available partitions:"
    sinfo -o "  %10P %5D %10G %10a %20F" 2>/dev/null | head -10
    echo ""

    for part in batch gpu_v100s gpu_a100 gpu_a40; do
        if sinfo -o "%P" 2>/dev/null | grep -q "^${part}"; then
            check_pass "Partition '${part}' available"
        else
            check_warn "Partition '${part}' not found (may have different name)"
        fi
    done
else
    check_warn "SLURM not available (running outside HPC?)"
fi

# Module system
if command -v module &>/dev/null; then
    check_pass "Module system available"

    # Check key modules
    for mod in anaconda3 cuda; do
        if module avail "$mod" 2>&1 | grep -qi "$mod"; then
            check_pass "Module '${mod}' available"
        else
            check_warn "Module '${mod}' not found in module system"
        fi
    done
else
    check_warn "Module system not available"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "2. Conda Environment"
# ═══════════════════════════════════════════════════════════════════════════════

# Initialize conda
eval "$(conda shell.bash hook 2>/dev/null)" || \
    source "$(conda info --base)/etc/profile.d/conda.sh" 2>/dev/null || true

if conda env list 2>/dev/null | grep -q "^${CONDA_ENV} "; then
    check_pass "Conda environment '${CONDA_ENV}' exists"

    # Activate
    conda activate "$CONDA_ENV" 2>/dev/null || source activate "$CONDA_ENV" 2>/dev/null

    PYTHON_VER=$(python --version 2>&1 | cut -d' ' -f2)
    check_pass "Python version: ${PYTHON_VER}"

    # Check required packages
    echo ""
    REQUIRED_PACKAGES=(
        "torch:PyTorch"
        "torchvision:TorchVision"
        "timm:timm"
        "sklearn:scikit-learn"
        "pandas:pandas"
        "numpy:NumPy"
        "cv2:OpenCV"
        "PIL:Pillow"
        "albumentations:Albumentations"
        "scipy:SciPy"
        "matplotlib:Matplotlib"
        "seaborn:Seaborn"
        "tqdm:tqdm"
        "yaml:PyYAML"
        "tensorboard:TensorBoard"
    )

    for entry in "${REQUIRED_PACKAGES[@]}"; do
        module_name="${entry%%:*}"
        display_name="${entry#*:}"
        if python -c "import ${module_name}" 2>/dev/null; then
            ver=$(python -c "import ${module_name}; print(getattr(${module_name}, '__version__', 'ok'))" 2>/dev/null || echo "ok")
            check_pass "${display_name}: ${ver}"
        else
            check_fail "${display_name}: NOT INSTALLED"
        fi
    done

    # Check ShareGuard package
    echo ""
    if python -c "import shareguard" 2>/dev/null; then
        SG_VER=$(python -c "import shareguard; print(shareguard.__version__)" 2>/dev/null || echo "unknown")
        check_pass "ShareGuard package: v${SG_VER}"
    else
        check_fail "ShareGuard package NOT INSTALLED (run: pip install -e .)"
    fi
else
    check_fail "Conda environment '${CONDA_ENV}' not found"
    check_fail "Run: bash scripts/hpc/setup_environment.sh"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "3. CUDA and GPU"
# ═══════════════════════════════════════════════════════════════════════════════

if python -c "import torch" 2>/dev/null; then
    CUDA_AVAIL=$(python -c "import torch; print('YES' if torch.cuda.is_available() else 'NO')" 2>/dev/null || echo "ERROR")

    if [[ "$CUDA_AVAIL" == "YES" ]]; then
        GPU_COUNT=$(python -c "import torch; print(torch.cuda.device_count())" 2>/dev/null)
        GPU_NAME=$(python -c "import torch; print(torch.cuda.get_device_name(0))" 2>/dev/null)
        CUDA_VER=$(python -c "import torch; print(torch.version.cuda)" 2>/dev/null)
        GPU_MEM=$(python -c "import torch; print(f'{torch.cuda.get_device_properties(0).total_mem / 1e9:.1f}GB')" 2>/dev/null)

        check_pass "CUDA available (v${CUDA_VER})"
        check_pass "GPU: ${GPU_NAME} (${GPU_MEM}), ${GPU_COUNT} device(s)"

        # Check GPU memory
        GPU_MEM_GB=$(python -c "import torch; print(int(torch.cuda.get_device_properties(0).total_mem / 1e9))" 2>/dev/null)
        if [[ "$GPU_MEM_GB" -ge 32 ]]; then
            check_pass "GPU memory: ${GPU_MEM_GB}GB (sufficient for all experiments)"
        elif [[ "$GPU_MEM_GB" -ge 16 ]]; then
            check_warn "GPU memory: ${GPU_MEM_GB}GB (may need smaller batch sizes)"
        else
            check_fail "GPU memory: ${GPU_MEM_GB}GB (insufficient, need 16GB+)"
        fi
    else
        check_warn "CUDA not available (CPU-only mode)"
        check_warn "GPU jobs will fail. Ensure you're on a GPU node."
    fi
else
    check_fail "PyTorch not installed, cannot check CUDA"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "4. Project Structure"
# ═══════════════════════════════════════════════════════════════════════════════

if [[ -d "$PROJECT_DIR" ]]; then
    check_pass "Project directory: ${PROJECT_DIR}"
else
    check_fail "Project directory not found: ${PROJECT_DIR}"
    echo "  Upload your code: scp -r ShareGuard <user>@burgundy:~/"
fi

# Check required directories
REQUIRED_DIRS=(
    "shareguard"
    "shareguard/datasets"
    "shareguard/models"
    "shareguard/engine"
    "shareguard/degradations"
    "shareguard/losses"
    "shareguard/analysis"
    "shareguard/hpc"
    "configs"
    "configs/data"
    "configs/model"
    "configs/train"
    "configs/eval"
    "scripts/hpc"
    "scripts/slurm"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [[ -d "${PROJECT_DIR}/${dir}" ]]; then
        check_pass "  ${dir}/"
    else
        check_fail "  ${dir}/ MISSING"
    fi
done

# Check key files
echo ""
REQUIRED_FILES=(
    "requirements.txt"
    "shareguard/__init__.py"
    "configs/data/genimage.yaml"
    "configs/model/dinov2_linear.yaml"
    "configs/train/shareguard_dinov2b.yaml"
    "scripts/hpc/setup_environment.sh"
    "scripts/hpc/download_genimage.sh"
    "scripts/hpc/run_pilot.sh"
    "scripts/hpc/run_pilot.slurm"
    "scripts/slurm/01_generate_degradation_array.slurm"
    "scripts/slurm/02_extract_features_array.slurm"
    "scripts/slurm/03_train_shareguard.slurm"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [[ -f "${PROJECT_DIR}/${file}" ]]; then
        check_pass "  ${file}"
    else
        check_warn "  ${file} MISSING"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════════
section "5. Disk Space"
# ═══════════════════════════════════════════════════════════════════════════════

# Home directory
HOME_AVAIL=$(df -BG "$HOME" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
HOME_TOTAL=$(df -BG "$HOME" 2>/dev/null | tail -1 | awk '{print $2}' | tr -d 'G')
if [[ "$HOME_AVAIL" -ge 5 ]]; then
    check_pass "Home (~): ${HOME_AVAIL}GB / ${HOME_TOTAL}GB available"
else
    check_fail "Home (~): ${HOME_AVAIL}GB / ${HOME_TOTAL}GB available (need 5GB+)"
fi

# Scratch directory
if [[ -n "${SCRATCH_DIR}" && -d "$SCRATCH_DIR" ]]; then
    SCRA_AVAIL=$(df -BG "$SCRATCH_DIR" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    SCRA_TOTAL=$(df -BG "$SCRATCH_DIR" 2>/dev/null | tail -1 | awk '{print $2}' | tr -d 'G')
    if [[ "$SCRA_AVAIL" -ge 50 ]]; then
        check_pass "Scratch: ${SCRA_AVAIL}GB / ${SCRA_TOTAL}GB available"
    elif [[ "$SCRA_AVAIL" -ge 10 ]]; then
        check_warn "Scratch: ${SCRA_AVAIL}GB / ${SCRA_TOTAL}GB available (tight, need 50GB+)"
    else
        check_fail "Scratch: ${SCRA_AVAIL}GB / ${SCRA_TOTAL}GB available (insufficient)"
    fi
else
    check_warn "Scratch directory not found or \$SCRATCH not set"
    check_warn "Set with: export SCRATCH=\$HOME/scratch"
fi

# Local disk (compute node)
if [[ -d "/local" ]]; then
    LOCAL_AVAIL=$(df -BG /local 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    check_pass "Local disk: ${LOCAL_AVAIL}GB available (temporary, per-job)"
else
    check_warn "Local disk /local not found (only available on compute nodes)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "6. Data Availability"
# ═══════════════════════════════════════════════════════════════════════════════

GENIMAGE_DIR="${SCRATCH_DIR}/ShareGuard/data/raw/GenImage"
MANIFEST_DIR="${PROJECT_DIR}/data/manifests"

if [[ -d "$GENIMAGE_DIR" ]]; then
    IMG_COUNT=$(find "$GENIMAGE_DIR" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" \) 2>/dev/null | wc -l)
    if [[ "$IMG_COUNT" -gt 1000 ]]; then
        check_pass "GenImage dataset: ${IMG_COUNT} images at ${GENIMAGE_DIR}"
    elif [[ "$IMG_COUNT" -gt 0 ]]; then
        check_warn "GenImage dataset: only ${IMG_COUNT} images (may be incomplete)"
    else
        check_fail "GenImage dataset: directory exists but no images found"
    fi

    # Check per-generator
    echo ""
    for gen in stable_diffusion_v1 stable_diffusion_v1_5 adm glide midjourney dalle stable_diffusion_xl; do
        gen_dir="${GENIMAGE_DIR}/${gen}"
        if [[ -d "$gen_dir" ]]; then
            gen_count=$(find "$gen_dir" -type f \( -name "*.jpg" -o -name "*.png" -o -name "*.jpeg" -o -name "*.webp" \) 2>/dev/null | wc -l)
            if [[ "$gen_count" -gt 100 ]]; then
                check_pass "  ${gen}: ${gen_count} images"
            else
                check_warn "  ${gen}: only ${gen_count} images"
            fi
        else
            check_fail "  ${gen}: NOT FOUND"
        fi
    done
else
    check_fail "GenImage data not found at ${GENIMAGE_DIR}"
    check_fail "Run: bash scripts/hpc/download_genimage.sh"
fi

# Check manifests
echo ""
if [[ -f "${MANIFEST_DIR}/genimage_all.csv" ]]; then
    MANIFEST_LINES=$(wc -l < "${MANIFEST_DIR}/genimage_all.csv")
    check_pass "Manifest: genimage_all.csv (${MANIFEST_LINES} entries)"
else
    check_warn "Manifest: genimage_all.csv not found (will be created during download)"
fi

# Check feature cache
FEATURE_CACHE="${SCRATCH_DIR}/ShareGuard/data/feature_cache"
if [[ -d "$FEATURE_CACHE" ]]; then
    FC_COUNT=$(find "$FEATURE_CACHE" -name "*.pt" 2>/dev/null | wc -l)
    if [[ "$FC_COUNT" -gt 0 ]]; then
        check_pass "Feature cache: ${FC_COUNT} cached feature files"
    else
        check_warn "Feature cache: directory exists but empty"
    fi
else
    check_warn "Feature cache directory not found (will be created during feature extraction)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "7. Network Connectivity"
# ═══════════════════════════════════════════════════════════════════════════════

# Test PyPI
if curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://pypi.org 2>/dev/null | grep -q "200\|301"; then
    check_pass "PyPI reachable"
else
    check_warn "PyPI not reachable (pip install may fail)"
fi

# Test PyTorch download server
if curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://download.pytorch.org 2>/dev/null | grep -q "200\|301"; then
    check_pass "PyTorch download server reachable"
else
    check_warn "PyTorch download server not reachable"
fi

# Test HuggingFace
if curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://huggingface.co 2>/dev/null | grep -q "200\|301"; then
    check_pass "HuggingFace reachable"
else
    check_warn "HuggingFace not reachable (model downloads may fail)"
fi

# Test GitHub
if curl -s --max-time 5 -o /dev/null -w "%{http_code}" https://github.com 2>/dev/null | grep -q "200\|301"; then
    check_pass "GitHub reachable"
else
    check_warn "GitHub not reachable"
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "8. Smoke Test (GPU)"
# ═══════════════════════════════════════════════════════════════════════════════

if [[ "$QUICK" == true ]]; then
    check_warn "Skipped (--quick mode)"
elif [[ "$CUDA_AVAIL" != "YES" ]]; then
    check_warn "Skipped (no CUDA available)"
else
    echo "  Running 30-second GPU smoke test..."

    python -c "
import torch
import timm
import time

device = torch.device('cuda')
print(f'  Device: {torch.cuda.get_device_name(0)}')

# Load DINOv2
print('  Loading DINOv2 model...')
t0 = time.time()
model = timm.create_model('vit_base_patch14_dinov2.lvd142m', pretrained=False, num_classes=0)
model = model.to(device).eval()
load_time = time.time() - t0
print(f'  Model loaded in {load_time:.1f}s')

# Forward pass
print('  Running forward pass...')
dummy = torch.randn(4, 3, 512, 512).to(device)
with torch.no_grad():
    t0 = time.time()
    out = model(dummy)
    fwd_time = time.time() - t0
print(f'  Forward pass: {fwd_time:.2f}s for 4 images')
print(f'  Output shape: {out.shape}')
print(f'  Throughput: {4/fwd_time:.1f} images/sec')

# Memory usage
mem_allocated = torch.cuda.max_memory_allocated() / 1e9
print(f'  Peak GPU memory: {mem_allocated:.1f}GB')

if out.shape[1] == 768:
    print('  PASS: DINOv2 output dimension correct (768)')
else:
    print(f'  FAIL: Expected 768d, got {out.shape[1]}d')
    exit(1)
" 2>&1

    if [[ $? -eq 0 ]]; then
        check_pass "GPU smoke test passed"
    else
        check_fail "GPU smoke test failed"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "============================================"
echo " Validation Summary"
echo "============================================"
echo ""
echo -e "  ${GREEN}PASS${NC}: ${PASS_COUNT}"
echo -e "  ${YELLOW}WARN${NC}: ${WARN_COUNT}"
echo -e "  ${RED}FAIL${NC}: ${FAIL_COUNT}"
echo ""

if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN} All critical checks passed!${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo " Ready to run experiments:"
    echo "   1. Download data:  bash scripts/hpc/download_genimage.sh"
    echo "   2. Run pilot:      sbatch scripts/hpc/run_pilot.slurm"
    echo "   3. Full pipeline:  sbatch scripts/slurm/03_train_shareguard.slurm"
    echo ""
    exit 0
else
    echo -e "${RED}============================================${NC}"
    echo -e "${RED} ${FAIL_COUNT} critical check(s) FAILED${NC}"
    echo -e "${RED}============================================${NC}"
    echo ""
    echo " Please fix the FAIL items above before running experiments."
    echo " See HPC_QUICKSTART.md for detailed setup instructions."
    echo ""
    echo " Common fixes:"
    echo "   - Missing packages:  bash scripts/hpc/setup_environment.sh"
    echo "   - Missing data:      bash scripts/hpc/download_genimage.sh"
    echo "   - CUDA issues:       module load cuda/12.1"
    echo ""
    exit 1
fi
