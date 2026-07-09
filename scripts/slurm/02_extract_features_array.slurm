#!/bin/bash
#SBATCH --partition=gpu_v100s
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=80GB
#SBATCH --time=0-06:00:00
#SBATCH --array=0-49
#SBATCH --output=logs/feat_%A_%a.out
#SBATCH --error=logs/feat_%A_%a.err
#SBATCH --job-name=shareguard-features

# Extract features from encoder in parallel
# Usage: sbatch scripts/slurm/02_extract_features_array.slurm

set -e

source ~/.bashrc
conda activate shareguard

echo "=== Extracting Features ==="
echo "Job ID: ${SLURM_ARRAY_JOB_ID}"
echo "Task ID: ${SLURM_ARRAY_TASK_ID}"
echo "GPU: ${CUDA_VISIBLE_DEVICES}"
echo "Node: $(hostname)"
echo "Start: $(date)"

python -m shareguard.engine.extract_features \
  --manifest data/manifests/train.csv \
  --chunk-id ${SLURM_ARRAY_TASK_ID} \
  --num-chunks 50 \
  --encoder dinov2_vitb14 \
  --views original,jpeg90,crop_resize,platform_random \
  --precision fp16 \
  --output-dir data/feature_cache/dinov2_vitb14/

echo "End: $(date)"
