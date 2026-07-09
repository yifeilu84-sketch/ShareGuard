#!/bin/bash
# =============================================================================
# ShareGuard Pilot Experiment: DINOv2 Frozen Baseline on Small Subset
# =============================================================================
# Usage:
#   # Submit to SLURM (recommended):
#   sbatch scripts/hpc/run_pilot.slurm
#
#   # Run locally for testing:
#   bash scripts/hpc/run_pilot.sh
#
#   # Run with custom settings:
#   PILOT_SIZE=5000 GPU_PARTITION=gpu_a100 bash scripts/hpc/run_pilot.sh
#
# What this script does:
#   1. Validates environment and data availability
#   2. Builds a small manifest (10K images default)
#   3. Splits into train/val/test with leakage prevention
#   4. Extracts frozen DINOv2 features
#   5. Trains a linear probe classifier
#   6. Evaluates on clean and degraded data
#   7. Reports results and saves checkpoints
# =============================================================================

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
CONDA_ENV="shareguard"
PROJECT_DIR="${HOME}/ShareGuard"
SCRATCH_DIR="${SCRATCH:-${HOME}/scratch}"
DATA_DIR="${SCRATCH_DIR}/ShareGuard/data"
OUTPUT_DIR="${SCRATCH_DIR}/ShareGuard/outputs/pilot"
MANIFEST_DIR="${PROJECT_DIR}/data/manifests"
FEATURE_CACHE_DIR="${DATA_DIR}/feature_cache"
LOG_DIR="${PROJECT_DIR}/logs"

# Pilot experiment settings (override with env vars)
PILOT_SIZE="${PILOT_SIZE:-10000}"         # Number of images for pilot subset
BATCH_SIZE="${BATCH_SIZE:-256}"           # Feature extraction batch size
TRAIN_BATCH="${TRAIN_BATCH:-256}"         # Linear probe training batch size
EPOCHS="${EPOCHS:-20}"                    # Training epochs
LR="${LR:-1e-3}"                          # Learning rate
SEED="${SEED:-42}"                        # Random seed
IMAGE_SIZE="${IMAGE_SIZE:-512}"           # Input image resolution
NUM_WORKERS="${NUM_WORKERS:-4}"           # DataLoader workers
ENCODER="${ENCODER:-vit_base_patch14_dinov2.lvd142m}"  # DINOv2 model

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $(date +%H:%M:%S) $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $(date +%H:%M:%S) $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $(date +%H:%M:%S) $*"; }
log_err()   { echo -e "${RED}[ERROR]${NC} $(date +%H:%M:%S) $*"; }

# ─── Setup ───────────────────────────────────────────────────────────────────
SCRIPT_START=$(date +%s)

echo "============================================"
echo " ShareGuard Pilot Experiment"
echo " DINOv2 Frozen Baseline"
echo " $(date)"
echo "============================================"
echo ""
echo " Configuration:"
echo "   Pilot size:     ${PILOT_SIZE} images"
echo "   Encoder:        ${ENCODER}"
echo "   Image size:     ${IMAGE_SIZE}"
echo "   Batch size:     ${BATCH_SIZE}"
echo "   Epochs:         ${EPOCHS}"
echo "   Learning rate:  ${LR}"
echo "   Seed:           ${SEED}"
if [[ -n "${SLURM_JOB_ID:-}" ]]; then
    echo "   SLURM Job ID:   ${SLURM_JOB_ID}"
    echo "   Node:           $(hostname)"
    echo "   GPU:            ${CUDA_VISIBLE_DEVICES:-auto}"
fi
echo ""

# Create directories
mkdir -p "$OUTPUT_DIR" "$MANIFEST_DIR" "$FEATURE_CACHE_DIR" "$LOG_DIR"

# Activate conda
log_info "[1/8] Activating conda environment..."
source activate "$CONDA_ENV" 2>/dev/null || conda activate "$CONDA_ENV" 2>/dev/null || {
    log_err "Cannot activate conda env '${CONDA_ENV}'. Run: bash scripts/hpc/setup_environment.sh"
    exit 1
}
log_ok "Environment: ${CONDA_ENV} (Python $(python --version 2>&1 | cut -d' ' -f2))"

# Verify CUDA
CUDA_STATUS=$(python -c "import torch; print('YES' if torch.cuda.is_available() else 'NO')" 2>/dev/null || echo "FAILED")
if [[ "$CUDA_STATUS" == "YES" ]]; then
    GPU_NAME=$(python -c "import torch; print(torch.cuda.get_device_name(0))" 2>/dev/null)
    log_ok "CUDA: ${GPU_NAME}"
else
    log_warn "CUDA not available. Running on CPU (will be slow)."
fi

cd "$PROJECT_DIR"

# ─── Step 2: Check data ─────────────────────────────────────────────────────
log_info "[2/8] Checking data availability..."

GENIMAGE_DIR="${DATA_DIR}/raw/GenImage"
if [[ ! -d "$GENIMAGE_DIR" ]]; then
    log_err "GenImage data not found at ${GENIMAGE_DIR}"
    log_err "Run: bash scripts/hpc/download_genimage.sh"
    exit 1
fi

# Count available images
TOTAL_IMAGES=$(find "$GENIMAGE_DIR" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" \) 2>/dev/null | wc -l)
log_ok "Found ${TOTAL_IMAGES} images in ${GENIMAGE_DIR}"

if [[ "$TOTAL_IMAGES" -lt 1000 ]]; then
    log_err "Too few images (${TOTAL_IMAGES}). Need at least 1000."
    log_err "Run: bash scripts/hpc/download_genimage.sh"
    exit 1
fi

# ─── Step 3: Build pilot manifest ───────────────────────────────────────────
log_info "[3/8] Building pilot manifest (${PILOT_SIZE} image subset)..."

python -c "
import pandas as pd
from pathlib import Path
import random
import sys

random.seed(${SEED})

genimage_root = Path('${GENIMAGE_DIR}')
records = []

# Scan all generators
for gen_dir in sorted(genimage_root.iterdir()):
    if not gen_dir.is_dir():
        continue
    gen_name = gen_dir.name

    for label_name, label_val in [('ai', 1), ('nature', 0)]:
        search_dirs = [gen_dir / label_name]
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
    print('ERROR: No images found', file=sys.stderr)
    sys.exit(1)

df = pd.DataFrame(records)
print(f'Total available: {len(df)} images')

# Sample subset for pilot
target = ${PILOT_SIZE}
if len(df) > target:
    # Stratified sampling: keep class balance
    df_real = df[df.label == 0]
    df_fake = df[df.label == 1]
    n_real = min(len(df_real), target // 2)
    n_fake = min(len(df_fake), target - n_real)
    df = pd.concat([
        df_real.sample(n=n_real, random_state=${SEED}),
        df_fake.sample(n=n_fake, random_state=${SEED}),
    ]).sample(frac=1, random_state=${SEED}).reset_index(drop=True)

output_path = '${MANIFEST_DIR}/pilot_all.csv'
df.to_csv(output_path, index=False)
print(f'Pilot manifest: {len(df)} images (real={(df.label==0).sum()}, fake={(df.label==1).sum()})')
print(f'Saved to: {output_path}')
"

log_ok "Pilot manifest created"

# ─── Step 4: Split data ─────────────────────────────────────────────────────
log_info "[4/8] Splitting data (train/val/test, leakage-preventing)..."

python -m shareguard.datasets.split \
    --input "${MANIFEST_DIR}/pilot_all.csv" \
    --split_by source_id \
    --train_generators stable_diffusion_v1,stable_diffusion_v1_5,adm,glide \
    --test_generators midjourney,dalle,stable_diffusion_xl \
    --output_dir "${MANIFEST_DIR}/"

# Rename to pilot-specific names
for split in train val test; do
    src="${MANIFEST_DIR}/pilot_all_${split}.csv"
    dst="${MANIFEST_DIR}/pilot_${split}.csv"
    if [[ -f "$src" ]]; then
        mv "$src" "$dst"
    fi
done

TRAIN_COUNT=$(wc -l < "${MANIFEST_DIR}/pilot_train.csv" 2>/dev/null || echo "0")
VAL_COUNT=$(wc -l < "${MANIFEST_DIR}/pilot_val.csv" 2>/dev/null || echo "0")
TEST_COUNT=$(wc -l < "${MANIFEST_DIR}/pilot_test.csv" 2>/dev/null || echo "0")
log_ok "Split: train=${TRAIN_COUNT}, val=${VAL_COUNT}, test=${TEST_COUNT} (excluding header)"

# ─── Step 5: Extract DINOv2 features ────────────────────────────────────────
log_info "[5/8] Extracting frozen DINOv2 features..."

STEP_START=$(date +%s)

python -c "
import torch
import timm
import pandas as pd
import numpy as np
from PIL import Image
from torchvision import transforms
from tqdm import tqdm
from pathlib import Path
import sys

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f'Device: {device}')

# Load DINOv2 (frozen)
print('Loading DINOv2 model...')
model = timm.create_model('${ENCODER}', pretrained=True, num_classes=0)
model = model.to(device).eval()

# Freeze all parameters
for param in model.parameters():
    param.requires_grad = False

feat_dim = model.num_features
print(f'Feature dimension: {feat_dim}')

# Transform
transform = transforms.Compose([
    transforms.Resize(${IMAGE_SIZE}),
    transforms.CenterCrop(${IMAGE_SIZE}),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

# Process each split
for split in ['train', 'val', 'test']:
    manifest_path = '${MANIFEST_DIR}/pilot_' + split + '.csv'
    cache_path = '${FEATURE_CACHE_DIR}/pilot_' + split + '_dinov2.pt'

    try:
        df = pd.read_csv(manifest_path)
    except FileNotFoundError:
        print(f'Skipping {split}: manifest not found')
        continue

    if len(df) == 0:
        print(f'Skipping {split}: empty manifest')
        continue

    print(f'\\nProcessing {split}: {len(df)} images')

    features_list = []
    labels_list = []
    paths_list = []
    errors = 0

    for idx, row in tqdm(df.iterrows(), total=len(df), desc=f'  {split}'):
        try:
            img = Image.open(row['image_path']).convert('RGB')
            tensor = transform(img).unsqueeze(0).to(device)

            with torch.no_grad(), torch.cuda.amp.autocast(enabled=(device.type == 'cuda')):
                feat = model(tensor).cpu().float()

            features_list.append(feat)
            labels_list.append(row['label'])
            paths_list.append(row['image_path'])
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f'  Warning: {e}')
            continue

    if len(features_list) == 0:
        print(f'ERROR: No features extracted for {split}')
        continue

    features = torch.cat(features_list, dim=0)
    labels = torch.tensor(labels_list, dtype=torch.long)

    torch.save({
        'features': features,
        'labels': labels,
        'paths': paths_list,
        'encoder': '${ENCODER}',
        'feat_dim': feat_dim,
        'image_size': ${IMAGE_SIZE},
    }, cache_path)

    print(f'  Saved: {features.shape[0]} features x {features.shape[1]}d -> {cache_path}')
    if errors > 0:
        print(f'  ({errors} errors skipped)')

print('\\nFeature extraction complete.')
"

STEP_END=$(date +%s)
STEP_TIME=$((STEP_END - STEP_START))
log_ok "Features extracted in ${STEP_TIME}s"

# ─── Step 6: Train linear probe ─────────────────────────────────────────────
log_info "[6/8] Training linear probe classifier..."

STEP_START=$(date +%s)

python -c "
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.metrics import roc_auc_score, accuracy_score, f1_score
import numpy as np
import json
from pathlib import Path

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
print(f'Device: {device}')

# Load features
train_cache = '${FEATURE_CACHE_DIR}/pilot_train_dinov2.pt'
val_cache = '${FEATURE_CACHE_DIR}/pilot_val_dinov2.pt'

train_data = torch.load(train_cache, map_location='cpu')
val_data = torch.load(val_cache, map_location='cpu')

feat_dim = train_data['features'].shape[1]
print(f'Train: {train_data[\"features\"].shape[0]} samples, {feat_dim}d features')
print(f'Val:   {val_data[\"features\"].shape[0]} samples')

# Create dataloaders
train_dataset = TensorDataset(train_data['features'], train_data['labels'])
val_dataset = TensorDataset(val_data['features'], val_data['labels'])

train_loader = DataLoader(train_dataset, batch_size=${TRAIN_BATCH}, shuffle=True, num_workers=0)
val_loader = DataLoader(val_dataset, batch_size=${TRAIN_BATCH}, shuffle=False, num_workers=0)

# Model: simple linear probe
model = nn.Linear(feat_dim, 1).to(device)
optimizer = torch.optim.AdamW(model.parameters(), lr=${LR}, weight_decay=1e-4)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=${EPOCHS})
criterion = nn.BCEWithLogitsLoss()

# Training loop
best_auc = 0.0
best_epoch = 0
patience_counter = 0
patience = 5
history = []

print(f'\\nTraining for ${EPOCHS} epochs (patience={patience})...')
print('-' * 60)

for epoch in range(${EPOCHS}):
    # Train
    model.train()
    train_loss = 0.0
    for features, labels in train_loader:
        features = features.to(device)
        labels = labels.to(device).float()

        logits = model(features).squeeze()
        loss = criterion(logits, labels)

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        train_loss += loss.item()

    scheduler.step()
    avg_loss = train_loss / len(train_loader)

    # Validate
    model.eval()
    all_probs = []
    all_labels = []

    with torch.no_grad():
        for features, labels in val_loader:
            features = features.to(device)
            logits = model(features).squeeze()
            probs = torch.sigmoid(logits).cpu()
            all_probs.extend(probs.numpy())
            all_labels.extend(labels.numpy())

    all_probs = np.array(all_probs)
    all_labels = np.array(all_labels)

    # Metrics
    auc = roc_auc_score(all_labels, all_probs)
    preds = (all_probs > 0.5).astype(int)
    acc = accuracy_score(all_labels, preds)
    f1 = f1_score(all_labels, preds)

    history.append({
        'epoch': epoch + 1,
        'loss': avg_loss,
        'val_auc': auc,
        'val_acc': acc,
        'val_f1': f1,
        'lr': scheduler.get_last_lr()[0],
    })

    print(f'Epoch {epoch+1:3d} | Loss: {avg_loss:.4f} | AUC: {auc:.4f} | Acc: {acc:.4f} | F1: {f1:.4f}')

    # Early stopping
    if auc > best_auc:
        best_auc = auc
        best_epoch = epoch + 1
        patience_counter = 0
        torch.save({
            'model_state_dict': model.state_dict(),
            'feat_dim': feat_dim,
            'best_auc': best_auc,
            'best_epoch': best_epoch,
            'encoder': '${ENCODER}',
        }, '${OUTPUT_DIR}/dinov2_linear_best.pt')
    else:
        patience_counter += 1
        if patience_counter >= patience:
            print(f'\\nEarly stopping at epoch {epoch+1} (no improvement for {patience} epochs)')
            break

print('-' * 60)
print(f'\\nBest Validation AUC: {best_auc:.4f} (epoch {best_epoch})')

# Save training history
results = {
    'experiment': 'pilot_dinov2_frozen',
    'encoder': '${ENCODER}',
    'image_size': ${IMAGE_SIZE},
    'epochs_total': ${EPOCHS},
    'epochs_run': len(history),
    'best_epoch': best_epoch,
    'best_val_auc': best_auc,
    'train_samples': int(train_data['features'].shape[0]),
    'val_samples': int(val_data['features'].shape[0]),
    'feat_dim': feat_dim,
    'lr': ${LR},
    'batch_size': ${TRAIN_BATCH},
    'seed': ${SEED},
    'history': history,
}

with open('${OUTPUT_DIR}/pilot_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f'Results saved to: ${OUTPUT_DIR}/pilot_results.json')
print(f'Checkpoint saved to: ${OUTPUT_DIR}/dinov2_linear_best.pt')
"

STEP_END=$(date +%s)
STEP_TIME=$((STEP_END - STEP_START))
log_ok "Training completed in ${STEP_TIME}s"

# ─── Step 7: Evaluate on test set ───────────────────────────────────────────
log_info "[7/8] Evaluating on test set..."

python -c "
import torch
import torch.nn as nn
import numpy as np
from sklearn.metrics import roc_auc_score, accuracy_score, f1_score, classification_report
import json

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# Load test features
test_cache = '${FEATURE_CACHE_DIR}/pilot_test_dinov2.pt'
try:
    test_data = torch.load(test_cache, map_location='cpu')
except FileNotFoundError:
    print('Test features not found (test generators may not be in pilot subset). Skipping.')
    exit(0)

# Load best model
checkpoint = torch.load('${OUTPUT_DIR}/dinov2_linear_best.pt', map_location='cpu')
feat_dim = checkpoint['feat_dim']

model = nn.Linear(feat_dim, 1).to(device)
model.load_state_dict(checkpoint['model_state_dict'])
model.eval()

# Evaluate
features = test_data['features'].to(device)
labels = test_data['labels'].numpy()

with torch.no_grad():
    logits = model(features).squeeze()
    probs = torch.sigmoid(logits).cpu().numpy()

preds = (probs > 0.5).astype(int)

auc = roc_auc_score(labels, probs)
acc = accuracy_score(labels, preds)
f1 = f1_score(labels, preds)

print(f'Test Results (cross-generator):')
print(f'  AUC:  {auc:.4f}')
print(f'  Acc:  {acc:.4f}')
print(f'  F1:   {f1:.4f}')
print()
print(classification_report(labels, preds, target_names=['Real', 'Fake']))

# Update results
with open('${OUTPUT_DIR}/pilot_results.json', 'r') as f:
    results = json.load(f)

results['test_auc'] = auc
results['test_acc'] = acc
results['test_f1'] = f1
results['test_samples'] = int(test_data['features'].shape[0])

with open('${OUTPUT_DIR}/pilot_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print(f'Test results saved to: ${OUTPUT_DIR}/pilot_results.json')
"

# ─── Step 8: Summary ────────────────────────────────────────────────────────
SCRIPT_END=$(date +%s)
TOTAL_TIME=$((SCRIPT_END - SCRIPT_START))

log_info "[8/8] Generating summary..."

echo ""
echo "============================================"
echo " Pilot Experiment Complete"
echo "============================================"
echo ""
echo " Timing:"
echo "   Total runtime: ${TOTAL_TIME}s ($((TOTAL_TIME / 60))m $((TOTAL_TIME % 60))s)"
echo ""
echo " Results:"
if [[ -f "${OUTPUT_DIR}/pilot_results.json" ]]; then
    python -c "
import json
with open('${OUTPUT_DIR}/pilot_results.json') as f:
    r = json.load(f)
print(f\"   Encoder:       {r['encoder']}\")
print(f\"   Train samples: {r['train_samples']}\")
print(f\"   Val samples:   {r['val_samples']}\")
if 'test_samples' in r:
    print(f\"   Test samples:  {r['test_samples']}\")
print(f\"   Best val AUC:  {r['best_val_auc']:.4f} (epoch {r['best_epoch']})\")
if 'test_auc' in r:
    print(f\"   Test AUC:      {r['test_auc']:.4f}\")
    print(f\"   Test Acc:      {r['test_acc']:.4f}\")
    print(f\"   Test F1:       {r['test_f1']:.4f}\")
" 2>/dev/null || echo "   (see ${OUTPUT_DIR}/pilot_results.json)"
fi
echo ""
echo " Output files:"
echo "   Results:    ${OUTPUT_DIR}/pilot_results.json"
echo "   Checkpoint: ${OUTPUT_DIR}/dinov2_linear_best.pt"
echo "   Features:   ${FEATURE_CACHE_DIR}/pilot_*_dinov2.pt"
echo ""
echo " Next steps:"
echo "   1. If AUC > 0.90, baseline is working. Proceed to full training."
echo "   2. Run full ShareGuard: sbatch scripts/slurm/03_train_shareguard.slurm"
echo "   3. Add degradations:    sbatch scripts/slurm/01_generate_degradation_array.slurm"
echo "============================================"
