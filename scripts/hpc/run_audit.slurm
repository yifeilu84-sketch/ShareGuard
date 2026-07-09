#!/bin/bash
#SBATCH --partition=batch
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32GB
#SBATCH --time=0-01:00:00
#SBATCH --output=logs/audit_%j.out
#SBATCH --error=logs/audit_%j.err

unset PYTHONPATH
module purge
module load default
module load Miniconda3/24.7
source activate shareguard
cd ~/ShareGuard

python -c "
import pandas as pd
import json
from pathlib import Path
import hashlib

def hash_file(filepath):
    sha256 = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256.update(chunk)
    return sha256.hexdigest()

print('=== ShareGuard Experiment Protocol Audit ===')
print()

# 1. Check manifests
manifest_dir = Path('data/manifests')
manifests = list(manifest_dir.glob('*.csv'))
print(f'1. Manifests found: {len(manifests)}')
for m in manifests:
    df = pd.read_csv(m)
    print(f'   - {m.name}: {len(df)} rows, columns={list(df.columns)}')
    if 'label' in df.columns:
        print(f'     Labels: {df.label.value_counts().to_dict()}')

# 2. Check Tiny-GenImage manifest
tiny_manifest = manifest_dir / 'tiny_genimage_all.csv'
if tiny_manifest.exists():
    df = pd.read_csv(tiny_manifest)
    print(f'\\n2. Tiny-GenImage Manifest Analysis:')
    print(f'   - Total images: {len(df)}')
    print(f'   - Labels: {df.label.value_counts().to_dict()}')
    print(f'   - Columns: {list(df.columns)}')

    # Check train/val split
    df_shuffled = df.sample(frac=1, random_state=42).reset_index(drop=True)
    n_train = int(len(df_shuffled) * 0.8)
    df_train = df_shuffled.head(n_train)
    df_val = df_shuffled.tail(len(df_shuffled) - n_train)

    print(f'\\n3. Train/Val Split (80/20, seed=42):')
    print(f'   - Train: {len(df_train)} images')
    print(f'   - Val: {len(df_val)} images')
    print(f'   - Train labels: {df_train.label.value_counts().to_dict()}')
    print(f'   - Val labels: {df_val.label.value_counts().to_dict()}')

    # Check for source leakage
    train_paths = set(df_train['image_path'])
    val_paths = set(df_val['image_path'])
    overlap = train_paths & val_paths
    print(f'\\n4. Source Leakage Check:')
    print(f'   - Train/Val path overlap: {len(overlap)}')

    # Check if real/fake are from same source
    if 'image_path' in df.columns:
        df['source_id'] = df['image_path'].apply(lambda x: Path(x).stem.split('_')[0])
        train_sources = set(df_train['image_path'].apply(lambda x: Path(x).stem.split('_')[0]))
        val_sources = set(df_val['image_path'].apply(lambda x: Path(x).stem.split('_')[0]))
        source_overlap = train_sources & val_sources
        print(f'   - Train/Val source_id overlap: {len(source_overlap)}')

# 3. Check checkpoints
checkpoint_dir = Path('outputs/checkpoints')
checkpoints = list(checkpoint_dir.glob('*.pt'))
print(f'\\n5. Checkpoints found: {len(checkpoints)}')
for c in checkpoints:
    print(f'   - {c.name}')

# 4. Check logs
log_dir = Path('logs')
if log_dir.exists():
    logs = list(log_dir.glob('*.out'))
    print(f'\\n6. Log files found: {len(logs)}')

# 5. Threshold analysis
print(f'\\n7. Threshold Analysis:')
print(f'   - Fixed threshold: 0.5 (hardcoded in all evaluation code)')
print(f'   - Per-degradation tuning: NO')
print(f'   - find_optimal_threshold() exists but is NEVER CALLED')

# 6. Issues summary
print(f'\\n=== Issues Summary ===')
issues = []
if tiny_manifest.exists():
    # Check if test set is properly separated
    df_all = pd.read_csv(tiny_manifest)
    if 'generator' not in df_all.columns:
        issues.append('No generator column in manifest - cannot verify cross-generator split')
    if 'source_id' not in df_all.columns:
        issues.append('No source_id column - source leakage check is approximate')

issues.append('Threshold fixed at 0.5 - may not be optimal for degraded images')
issues.append('No formal experiment registry - runs not tracked with run_id')
issues.append('No per-sample predictions saved - cannot verify results')

for i, issue in enumerate(issues, 1):
    print(f'   {i}. {issue}')

print(f'\\n=== Recommendations ===')
recs = [
    'Add source_id column to manifest for proper leakage check',
    'Implement threshold tuning on clean validation set',
    'Save per-sample predictions with run_id',
    'Use experiment registry for all runs',
    'Expand test set to 5000+ images',
]
for i, rec in enumerate(recs, 1):
    print(f'   {i}. {rec}')
"
