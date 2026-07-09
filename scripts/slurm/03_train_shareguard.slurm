#!/bin/bash
#SBATCH --partition=gpu_a100
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=100GB
#SBATCH --time=1-00:00:00
#SBATCH --output=logs/train_shareguard_%j.out
#SBATCH --error=logs/train_shareguard_%j.err
#SBATCH --job-name=shareguard-train

# Train ShareGuard model
# Usage: sbatch scripts/slurm/03_train_shareguard.slurm

set -e

source ~/.bashrc
conda activate shareguard

echo "=== Training ShareGuard ==="
echo "Job ID: ${SLURM_JOB_ID}"
echo "GPU: ${CUDA_VISIBLE_DEVICES}"
echo "Node: $(hostname)"
echo "Start: $(date)"

# Option 1: Train with cached features (faster)
python -m shareguard.engine.train \
  --config configs/train/shareguard_dinov2b.yaml \
  --train-features data/feature_cache/dinov2_vitb14/train_fp16.pt \
  --val-features data/feature_cache/dinov2_vitb14/val_fp16.pt \
  --output-dir outputs/checkpoints/shareguard_dinov2b/

# Option 2: Train with LoRA (uncomment if needed)
# python -m shareguard.engine.train_lora \
#   --config configs/train/shareguard_lora_dinov2b.yaml \
#   --train-manifest data/manifests/train.csv \
#   --val-manifest data/manifests/val.csv \
#   --output-dir outputs/checkpoints/shareguard_lora_dinov2b/

echo "End: $(date)"
