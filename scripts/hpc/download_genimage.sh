#!/bin/bash
# =============================================================================
# ShareGuard: Download GenImage Dataset to HPC Scratch Storage
# =============================================================================
# Usage:
#   bash scripts/hpc/download_genimage.sh              # Full download
#   bash scripts/hpc/download_genimage.sh --small       # Small subset only (~5GB)
#   bash scripts/hpc/download_genimage.sh --verify      # Verify existing download
#
# GenImage dataset structure:
#   GenImage/
#   ├── stable_diffusion_v1/   (train generator)
#   │   ├── ai/                (AI-generated images)
#   │   └── nature/            (real images)
#   ├── stable_diffusion_v1_5/ (train generator)
#   ├── adm/                   (train generator)
#   ├── glide/                 (train generator)
#   ├── midjourney/            (test generator)
#   ├── dalle/                 (test generator)
#   └── stable_diffusion_xl/   (test generator)
#
# Storage plan:
#   - Raw data -> $SCRATCH/ShareGuard/data/raw/GenImage  (~200-250GB full)
#   - Manifests -> $HOME/ShareGuard/data/manifests/      (~small CSV files)
#   - Feature cache -> $SCRATCH/ShareGuard/data/feature_cache/
# =============================================================================

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
PROJECT_DIR="${HOME}/ShareGuard"
SCRATCH_DIR="${SCRATCH:-${HOME}/scratch}"
DATA_ROOT="${SCRATCH_DIR}/ShareGuard/data"
GENIMAGE_DIR="${DATA_ROOT}/raw/GenImage"
MANIFEST_DIR="${PROJECT_DIR}/data/manifests"
FEATURE_CACHE_DIR="${DATA_ROOT}/feature_cache"

# GenImage download sources
# Primary: HuggingFace dataset repository
GENIMAGE_HF_REPO="datasets/GenImage/GenImage"
# Fallback: direct links from GenImage paper authors
GENIMAGE_BASE_URL="https://huggingface.co/datasets/GenImage/GenImage/resolve/main"

# Generators in the dataset
ALL_GENERATORS=(
    "stable_diffusion_v1"
    "stable_diffusion_v1_5"
    "adm"
    "glide"
    "midjourney"
    "dalle"
    "stable_diffusion_xl"
)

TRAIN_GENERATORS=("stable_diffusion_v1" "stable_diffusion_v1_5" "adm" "glide")
TEST_GENERATORS=("midjourney" "dalle" "stable_diffusion_xl")

# ─── Colors and logging ─────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Parse arguments ────────────────────────────────────────────────────────
MODE="full"
for arg in "$@"; do
    case "$arg" in
        --small)    MODE="small" ;;
        --verify)   MODE="verify" ;;
        --help|-h)
            echo "Usage: $0 [--small|--verify|--help]"
            echo "  --small   Download only 2 generators (~5GB) for testing"
            echo "  --verify  Verify existing download without downloading"
            echo "  --help    Show this help"
            exit 0
            ;;
    esac
done

# ─── Helper functions ───────────────────────────────────────────────────────
check_disk_space() {
    local dir="$1"
    local need_gb="$2"
    local avail_gb
    avail_gb=$(df -BG "$dir" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    if [[ "$avail_gb" -lt "$need_gb" ]]; then
        log_err "Insufficient disk space at $dir: need ${need_gb}GB, have ${avail_gb}GB"
        return 1
    fi
    log_ok "Disk space OK: ${avail_gb}GB available at $dir (need ${need_gb}GB)"
    return 0
}

count_images() {
    local dir="$1"
    find "$dir" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" \) 2>/dev/null | wc -l
}

# ─── Mode: Verify ───────────────────────────────────────────────────────────
if [[ "$MODE" == "verify" ]]; then
    echo "============================================"
    echo " GenImage Dataset Verification"
    echo "============================================"
    echo ""

    if [[ ! -d "$GENIMAGE_DIR" ]]; then
        log_err "GenImage directory not found at $GENIMAGE_DIR"
        exit 1
    fi

    ERRORS=0
    TOTAL=0
    for gen in "${ALL_GENERATORS[@]}"; do
        gen_dir="${GENIMAGE_DIR}/${gen}"
        if [[ -d "$gen_dir" ]]; then
            count=$(count_images "$gen_dir")
            TOTAL=$((TOTAL + count))
            if [[ "$count" -gt 0 ]]; then
                log_ok "  ${gen}: ${count} images"
            else
                log_err "  ${gen}: directory exists but no images found"
                ERRORS=$((ERRORS + 1))
            fi
        else
            log_err "  ${gen}: MISSING"
            ERRORS=$((ERRORS + 1))
        fi
    done

    echo ""
    if [[ "$ERRORS" -eq 0 ]]; then
        log_ok "All generators present. Total: ${TOTAL} images"
    else
        log_err "${ERRORS} generator(s) missing or empty. Total found: ${TOTAL} images"
    fi
    exit $ERRORS
fi

# ─── Mode: Download ─────────────────────────────────────────────────────────
echo "============================================"
echo " GenImage Dataset Download"
echo " Mode: ${MODE}"
echo " $(date)"
echo "============================================"
echo ""

# Determine which generators to download
if [[ "$MODE" == "small" ]]; then
    DOWNLOAD_GENERATORS=("stable_diffusion_v1" "adm")
    REQUIRED_SPACE_GB=10
    log_info "Small mode: downloading 2 generators (~${REQUIRED_SPACE_GB}GB)"
else
    DOWNLOAD_GENERATORS=("${ALL_GENERATORS[@]}")
    REQUIRED_SPACE_GB=250
    log_info "Full mode: downloading all 7 generators (~${REQUIRED_SPACE_GB}GB)"
fi

# Check disk space
log_info "Checking disk space..."
check_disk_space "$SCRATCH_DIR" "$REQUIRED_SPACE_GB" || exit 1

# Create directories
mkdir -p "$GENIMAGE_DIR"
mkdir -p "$MANIFEST_DIR"
mkdir -p "$FEATURE_CACHE_DIR"

# ─── Check for existing data ────────────────────────────────────────────────
log_info "Checking for existing data..."

EXISTING=()
MISSING=()
for gen in "${DOWNLOAD_GENERATORS[@]}"; do
    gen_dir="${GENIMAGE_DIR}/${gen}"
    if [[ -d "$gen_dir" ]] && [[ $(count_images "$gen_dir") -gt 100 ]]; then
        EXISTING+=("$gen")
        log_ok "  ${gen} already exists ($(count_images "$gen_dir") images)"
    else
        MISSING+=("$gen")
    fi
done

if [[ ${#EXISTING[@]} -eq ${#DOWNLOAD_GENERATORS[@]} ]]; then
    log_ok "All requested generators already downloaded!"
    echo ""
    log_info "Next step: Build manifest"
    log_info "  cd ${PROJECT_DIR}"
    log_info "  python -m shareguard.datasets.build_manifest \\"
    log_info "    --dataset genimage \\"
    log_info "    --root ${GENIMAGE_DIR} \\"
    log_info "    --output ${MANIFEST_DIR}/genimage_all.csv"
    exit 0
fi

if [[ ${#EXISTING[@]} -gt 0 ]]; then
    log_info "Skipping ${#EXISTING[@]} already-downloaded generators"
fi

# ─── Download using multiple strategies ─────────────────────────────────────
log_info ""
log_info "Downloading ${#MISSING[@]} generators..."
log_info ""

DOWNLOAD_SUCCESS=()
DOWNLOAD_FAILED=()

for gen in "${MISSING[@]}"; do
    gen_dir="${GENIMAGE_DIR}/${gen}"
    mkdir -p "$gen_dir"

    log_info "─── Downloading: ${gen} ───"
    log_info "  Target: ${gen_dir}"

    SUCCESS=false

    # Strategy 1: HuggingFace CLI (preferred, supports resumable download)
    if command -v huggingface-cli &>/dev/null; then
        log_info "  Trying huggingface-cli download..."
        if huggingface-cli download \
            --repo-type dataset \
            "${GENIMAGE_HF_REPO}" \
            --include "${gen}/**" \
            --local-dir "${GENIMAGE_DIR}" \
            --resume-download \
            2>&1 | tail -5; then
            SUCCESS=true
            log_ok "  Downloaded ${gen} via huggingface-cli"
        else
            log_warn "  huggingface-cli failed for ${gen}"
        fi
    fi

    # Strategy 2: git clone with lfs (if HF CLI not available)
    if [[ "$SUCCESS" == false ]]; then
        log_info "  Trying git clone with LFS..."
        if command -v git-lfs &>/dev/null || git lfs version &>/dev/null; then
            # Clone only the specific subdirectory
            TEMP_CLONE="${gen_dir}_tmp"
            if git clone --depth 1 --filter=blob:none --sparse \
                "https://huggingface.co/datasets/${GENIMAGE_HF_REPO}" \
                "$TEMP_CLONE" 2>/dev/null; then
                cd "$TEMP_CLONE"
                git sparse-checkout set "$gen"
                git lfs pull
                mv "$gen"/* "$gen_dir/" 2>/dev/null || true
                cd ..
                rm -rf "$TEMP_CLONE"
                SUCCESS=true
                log_ok "  Downloaded ${gen} via git sparse-checkout"
            else
                rm -rf "$TEMP_CLONE"
                log_warn "  git clone failed for ${gen}"
            fi
        else
            log_warn "  git-lfs not available"
        fi
    fi

    # Strategy 3: wget direct download (fallback)
    if [[ "$SUCCESS" == false ]]; then
        log_info "  Trying wget direct download..."
        for subfolder in "ai" "nature"; do
            sub_dir="${gen_dir}/${subfolder}"
            mkdir -p "$sub_dir"
            URL="${GENIMAGE_BASE_URL}/${gen}/${subfolder}.zip"
            ZIP_FILE="${gen_dir}/${subfolder}.zip"

            if wget -q --spider "$URL" 2>/dev/null; then
                log_info "    Downloading ${subfolder}.zip..."
                if wget -c -q --show-progress -O "$ZIP_FILE" "$URL" 2>&1 | tail -3; then
                    log_info "    Extracting ${subfolder}.zip..."
                    unzip -q -o "$ZIP_FILE" -d "$gen_dir/" 2>/dev/null || \
                    unzip -q -o "$ZIP_FILE" -d "$sub_dir/" 2>/dev/null || true
                    rm -f "$ZIP_FILE"
                    SUCCESS=true
                fi
            fi
        done
        if [[ "$SUCCESS" == true ]]; then
            log_ok "  Downloaded ${gen} via wget"
        fi
    fi

    # Strategy 4: Kaggle (some GenImage mirrors exist on Kaggle)
    if [[ "$SUCCESS" == false ]]; then
        if command -v kaggle &>/dev/null; then
            log_info "  Trying Kaggle download..."
            if kaggle datasets download -d "genimage/${gen}" \
                -p "$gen_dir" --unzip 2>/dev/null; then
                SUCCESS=true
                log_ok "  Downloaded ${gen} via Kaggle"
            fi
        fi
    fi

    # Record result
    if [[ "$SUCCESS" == true ]]; then
        DOWNLOAD_SUCCESS+=("$gen")
        img_count=$(count_images "$gen_dir")
        log_ok "  ${gen}: ${img_count} images downloaded"
    else
        DOWNLOAD_FAILED+=("$gen")
        log_err "  ${gen}: ALL download methods failed"
        log_err "  Manual download required. See instructions below."
    fi
    echo ""
done

# ─── Summary ────────────────────────────────────────────────────────────────
echo "============================================"
echo " Download Summary"
echo "============================================"
echo ""

if [[ ${#DOWNLOAD_SUCCESS[@]} -gt 0 ]]; then
    log_ok "Successfully downloaded:"
    for gen in "${DOWNLOAD_SUCCESS[@]}"; do
        echo "    - ${gen} ($(count_images "${GENIMAGE_DIR}/${gen}") images)"
    done
fi

if [[ ${#DOWNLOAD_FAILED[@]} -gt 0 ]]; then
    echo ""
    log_err "Failed to download:"
    for gen in "${DOWNLOAD_FAILED[@]}"; do
        echo "    - ${gen}"
    done
    echo ""
    echo "Manual download instructions:"
    echo "  1. Visit: https://huggingface.co/datasets/GenImage/GenImage"
    echo "  2. Download the missing generator folders"
    echo "  3. Upload to HPC:"
    echo "     scp -r /local/path/${gen} \\"
    echo "       <user>@burgundy.hpc.cityu.edu.hk:${GENIMAGE_DIR}/"
    echo ""
    echo "Alternative: Install huggingface-cli for automatic download:"
    echo "  pip install huggingface_hub[cli]"
    echo "  huggingface-cli login"
    echo "  bash scripts/hpc/download_genimage.sh"
    exit 1
fi

# ─── Build manifest ─────────────────────────────────────────────────────────
echo ""
log_info "Building dataset manifest..."

cd "$PROJECT_DIR"

python -c "
import pandas as pd
from pathlib import Path
import random
import sys

random.seed(42)

genimage_root = Path('${GENIMAGE_DIR}')
records = []

# Scan all generators
for gen_dir in sorted(genimage_root.iterdir()):
    if not gen_dir.is_dir():
        continue
    gen_name = gen_dir.name

    # Find images in ai/ and nature/ subdirectories
    for label_name, label_val in [('ai', 1), ('nature', 0)]:
        search_dirs = [gen_dir / label_name]
        # Also check common alternative names
        if label_name == 'nature':
            search_dirs.append(gen_dir / 'real')

        for search_dir in search_dirs:
            if not search_dir.exists():
                continue
            for img_path in search_dir.rglob('*'):
                if img_path.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'):
                    records.append({
                        'image_path': str(img_path),
                        'label': label_val,
                        'source_dataset': 'GenImage',
                        'generator': gen_name,
                        'split': 'unassigned',
                    })

if len(records) == 0:
    print('ERROR: No images found. Download may have failed.', file=sys.stderr)
    sys.exit(1)

df = pd.DataFrame(records)
output_path = '${MANIFEST_DIR}/genimage_all.csv'
df.to_csv(output_path, index=False)

print(f'Manifest created: {output_path}')
print(f'Total images: {len(df)}')
print(f'Real (label=0): {(df.label == 0).sum()}')
print(f'Fake (label=1): {(df.label == 1).sum()}')
print()
print('Per generator:')
for gen, group in df.groupby('generator'):
    print(f'  {gen}: {len(group)} images ({(group.label==0).sum()} real, {(group.label==1).sum()} fake)')
"

echo ""
echo "============================================"
echo " Download Complete"
echo "============================================"
echo ""
echo " Data location:      ${GENIMAGE_DIR}"
echo " Manifest:           ${MANIFEST_DIR}/genimage_all.csv"
echo " Feature cache dir:  ${FEATURE_CACHE_DIR}"
echo ""
echo " Next steps:"
echo "   1. Validate data:  bash scripts/hpc/validate_setup.sh"
echo "   2. Run pilot:      sbatch scripts/hpc/run_pilot.slurm"
echo "============================================"
