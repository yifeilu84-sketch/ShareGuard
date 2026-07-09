#!/bin/bash
# Complete pilot experiment with degradation testing
# Tests: DINOv2 baseline + clean + 2 degradations
# Usage: bash scripts/hpc/run_pilot_with_degradation.sh

set -e

echo "=========================================="
echo "ShareGuard Pilot Experiment (Full)"
echo "=========================================="

# Configuration
CONDA_ENV="shareguard"
PROJECT_DIR="${HOME}/ShareGuard"
SCRATCH_DIR="${SCRATCH:-$HOME/scratch}"
DATA_DIR="$SCRATCH_DIR/ShareGuard/data"
OUTPUT_DIR="$SCRATCH_DIR/ShareGuard/outputs/pilot_full"

mkdir -p "$OUTPUT_DIR"

# Activate environment
source activate "$CONDA_ENV" 2>/dev/null || conda activate "$CONDA_ENV"
cd "$PROJECT_DIR"

# ============================================================
# Step 1: Verify data exists
# ============================================================
echo "[1/8] Verifying data..."
if [ ! -f "data/manifests/pilot_train.csv" ]; then
    echo "ERROR: Pilot manifest not found. Run run_pilot.sh first."
    exit 1
fi
echo "  ✓ Manifests found"

# ============================================================
# Step 2: Generate degraded test images
# ============================================================
echo "[2/8] Generating degraded test images..."

python -c "
import pandas as pd
from PIL import Image
from pathlib import Path
import io
from tqdm import tqdm

# Load test manifest
test_df = pd.read_csv('data/manifests/pilot_test.csv')
print(f'Test images: {len(test_df)}')

# Create degraded versions
degradations = {
    'jpeg_q50': lambda img: save_jpeg(img, 50),
    'share_medium': lambda img: apply_compound(img),
}

def save_jpeg(img, quality):
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality)
    buf.seek(0)
    return Image.open(buf).convert('RGB')

def apply_compound(img):
    # Resize to 720
    w, h = img.size
    if w < h:
        new_w = 720
        new_h = int(h * 720 / w)
    else:
        new_h = 720
        new_w = int(w * 720 / h)
    img = img.resize((new_w, new_h), Image.BICUBIC)

    # Center crop 95%
    w, h = img.size
    cw, ch = int(w * 0.95), int(h * 0.95)
    left = (w - cw) // 2
    top = (h - ch) // 2
    img = img.crop((left, top, left + cw, top + ch))

    # JPEG 70
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=70)
    buf.seek(0)
    return Image.open(buf).convert('RGB')

# Process each degradation
for deg_name, deg_fn in degradations.items():
    output_dir = Path(f'data/degraded_test/{deg_name}')
    output_dir.mkdir(parents=True, exist_ok=True)

    new_paths = []
    for _, row in tqdm(test_df.iterrows(), desc=deg_name):
        try:
            img = Image.open(row['image_path']).convert('RGB')
            degraded = deg_fn(img)
            out_path = output_dir / Path(row['image_path']).name
            degraded.save(out_path, format='JPEG', quality=95)
            new_paths.append(str(out_path))
        except Exception as e:
            new_paths.append(row['image_path'])

    # Save degraded manifest
    deg_df = test_df.copy()
    deg_df['image_path'] = new_paths
    deg_df['quality_group'] = deg_name
    deg_df.to_csv(f'data/manifests/pilot_test_{deg_name}.csv', index=False)
    print(f'Saved: data/manifests/pilot_test_{deg_name}.csv')
"

echo "  ✓ Degraded test sets created"

# ============================================================
# Step 3: Extract features for all sets
# ============================================================
echo "[3/8] Extracting DINOv2 features..."

python -c "
import torch
import timm
import pandas as pd
from PIL import Image
from torchvision import transforms
from tqdm import tqdm

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model = timm.create_model('vit_base_patch14_dinov2.lvd142m', pretrained=True, num_classes=0)
model = model.to(device).eval()

transform = transforms.Compose([
    transforms.Resize(512),
    transforms.CenterCrop(512),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

# Extract features for each test set
test_sets = ['pilot_test', 'pilot_test_jpeg_q50', 'pilot_test_share_medium']

for name in test_sets:
    df = pd.read_csv(f'data/manifests/{name}.csv')
    features = []
    labels = []

    for _, row in tqdm(df.iterrows(), total=len(df), desc=f'Extracting {name}'):
        try:
            img = Image.open(row['image_path']).convert('RGB')
            tensor = transform(img).unsqueeze(0).to(device)
            with torch.no_grad():
                feat = model(tensor).cpu()
            features.append(feat)
            labels.append(row['label'])
        except Exception as e:
            continue

    features = torch.cat(features, dim=0)
    labels = torch.tensor(labels)

    torch.save({'features': features, 'labels': labels},
               f'data/feature_cache/{name}_dinov2.pt')
    print(f'Saved {name}: {features.shape}')
"

echo "  ✓ Features extracted"

# ============================================================
# Step 4: Train and evaluate on clean
# ============================================================
echo "[4/8] Training DINOv2 linear probe..."

python -c "
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
from sklearn.metrics import roc_auc_score
import json

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# Load features
train_data = torch.load('data/feature_cache/pilot_train_dinov2.pt')
val_data = torch.load('data/feature_cache/pilot_val_dinov2.pt')

train_dataset = TensorDataset(train_data['features'], train_data['labels'])
val_dataset = TensorDataset(val_data['features'], val_data['labels'])

train_loader = DataLoader(train_dataset, batch_size=256, shuffle=True)
val_loader = DataLoader(val_dataset, batch_size=256, shuffle=False)

# Model
model = nn.Linear(train_data['features'].shape[1], 1).to(device)
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
criterion = nn.BCEWithLogitsLoss()

# Train
best_auc = 0
for epoch in range(20):
    model.train()
    for features, labels in train_loader:
        features, labels = features.to(device), labels.to(device).float()
        logits = model(features).squeeze()
        loss = criterion(logits, labels)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

    model.eval()
    all_scores = []
    all_labels = []
    with torch.no_grad():
        for features, labels in val_loader:
            features = features.to(device)
            logits = model(features).squeeze()
            probs = torch.sigmoid(logits).cpu()
            all_scores.extend(probs.numpy())
            all_labels.extend(labels.numpy())

    auc = roc_auc_score(all_labels, all_scores)
    if auc > best_auc:
        best_auc = auc
        torch.save(model.state_dict(), 'outputs/pilot_full/dinov2_linear_best.pt')

print(f'Best Clean Val AUC: {best_auc:.4f}')
"

echo "  ✓ Model trained"

# ============================================================
# Step 5: Evaluate on all test sets
# ============================================================
echo "[5/8] Evaluating on clean and degraded sets..."

python -c "
import torch
import torch.nn as nn
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score, f1_score, accuracy_score
import json

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# Load model
model = nn.Linear(768, 1).to(device)
model.load_state_dict(torch.load('outputs/pilot_full/dinov2_linear_best.pt'))
model.eval()

results = {}

test_sets = {
    'clean': 'pilot_test',
    'jpeg_q50': 'pilot_test_jpeg_q50',
    'share_medium': 'pilot_test_share_medium',
}

for deg_name, feat_name in test_sets.items():
    data = torch.load(f'data/feature_cache/{feat_name}_dinov2.pt')
    features = data['features'].to(device)
    labels = data['labels'].numpy()

    with torch.no_grad():
        logits = model(features).squeeze()
        probs = torch.sigmoid(logits).cpu().numpy()

    preds = (probs >= 0.5).astype(int)

    auc = roc_auc_score(labels, probs)
    ap = average_precision_score(labels, probs)
    f1 = f1_score(labels, preds)
    acc = accuracy_score(labels, preds)

    results[deg_name] = {'auc': auc, 'ap': ap, 'f1': f1, 'accuracy': acc}
    print(f'{deg_name}: AUC={auc:.4f}, AP={ap:.4f}, F1={f1:.4f}, Acc={acc:.4f}')

# Compute robustness drop
clean_auc = results['clean']['auc']
for deg_name in ['jpeg_q50', 'share_medium']:
    drop = clean_auc - results[deg_name]['auc']
    results[f'{deg_name}_drop'] = drop
    print(f'Robustness Drop ({deg_name}): {drop:.4f}')

# Save results
with open('outputs/pilot_full/results.json', 'w') as f:
    json.dump(results, f, indent=2)
"

echo "  ✓ Evaluation complete"

# ============================================================
# Step 6: Generate summary
# ============================================================
echo "[6/8] Generating summary..."

python -c "
import json

with open('outputs/pilot_full/results.json') as f:
    results = json.load(f)

print()
print('=' * 60)
print('PILOT EXPERIMENT RESULTS')
print('=' * 60)
print()
print(f\"Clean AUC:           {results['clean']['auc']:.4f}\")
print(f\"JPEG q50 AUC:        {results['jpeg_q50']['auc']:.4f}\")
print(f\"Compound AUC:        {results['share_medium']['auc']:.4f}\")
print()
print(f\"Robustness Drop (JPEG):    {results['jpeg_q50_drop']:.4f}\")
print(f\"Robustness Drop (Compound): {results['share_medium_drop']:.4f}\")
print()
print('=' * 60)

# Check success criteria
if results['clean']['auc'] > 0.90:
    print('✓ SUCCESS: Clean AUC > 0.90')
else:
    print('✗ WARNING: Clean AUC < 0.90')

if results['share_medium_drop'] > 0.05:
    print('✓ SUCCESS: Robustness drop detected (> 0.05)')
else:
    print('✗ WARNING: Robustness drop not significant')
"

echo ""
echo "=========================================="
echo "Pilot experiment complete!"
echo "=========================================="
echo "Results: outputs/pilot_full/results.json"
echo ""
echo "Next steps:"
echo "1. If robustness drop confirmed, proceed to full experiments"
echo "2. Run ShareGuard training: sbatch scripts/slurm/03_train_shareguard.slurm"
