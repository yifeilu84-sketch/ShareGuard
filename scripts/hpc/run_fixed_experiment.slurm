#!/bin/bash
#SBATCH --partition=gpu_v100s
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=80GB
#SBATCH --time=1-00:00:00
#SBATCH --output=logs/fixed_exp_%j.out
#SBATCH --error=logs/fixed_exp_%j.err

unset PYTHONPATH
module purge
module load default
module load Miniconda3/24.7
source activate shareguard
cd ~/ShareGuard

# Step 1: Fix manifest and split by source_id
echo "=== Step 1: Fix Manifest ==="
python scripts/fix_manifest.py \
    --input data/manifests/tiny_genimage_all.csv \
    --output-dir data/manifests/fixed \
    --seed 42

# Step 2: Expand test set to 5000+
echo "=== Step 2: Expand Test Set ==="
python scripts/expand_test_set.py \
    --input data/manifests/fixed/test.csv \
    --output data/manifests/fixed/test_5k.csv \
    --target-size 5000 \
    --seed 42

# Step 3: Train DINOv2 baseline with threshold tuning
echo "=== Step 3: Train DINOv2 Baseline ==="
python scripts/train_with_threshold.py \
    --config configs/model/dinov2_linear.yaml \
    --train-manifest data/manifests/fixed/train.csv \
    --val-manifest data/manifests/fixed/val.csv \
    --test-manifest data/manifests/fixed/test_5k.csv \
    --output-dir outputs/experiments/dinov2_fixed \
    --seed 42 \
    --model-name dinov2_baseline

# Step 4: Train ShareGuard-Aug with threshold tuning
echo "=== Step 4: Train ShareGuard-Aug ==="
python scripts/train_with_threshold.py \
    --config configs/train/shareguard_dinov2b.yaml \
    --train-manifest data/manifests/fixed/train.csv \
    --val-manifest data/manifests/fixed/val.csv \
    --test-manifest data/manifests/fixed/test_5k.csv \
    --output-dir outputs/experiments/shareguard_aug_fixed \
    --seed 42 \
    --model-name shareguard_aug

echo "=== Done ==="
