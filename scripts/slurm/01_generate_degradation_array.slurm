#!/bin/bash
#SBATCH --partition=batch
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=64GB
#SBATCH --time=0-08:00:00
#SBATCH --array=0-99
#SBATCH --output=logs/deg_%A_%a.out
#SBATCH --error=logs/deg_%A_%a.err
#SBATCH --job-name=shareguard-degradation

# Generate degraded test images in parallel
# Usage: sbatch scripts/slurm/01_generate_degradation_array.slurm

set -e

source ~/.bashrc
conda activate shareguard

echo "=== Generating Degradations ==="
echo "Job ID: ${SLURM_ARRAY_JOB_ID}"
echo "Task ID: ${SLURM_ARRAY_TASK_ID}"
echo "Node: $(hostname)"
echo "Start: $(date)"

python -m shareguard.degradations.generate \
  --manifest data/manifests/test_clean.csv \
  --chunk-id ${SLURM_ARRAY_TASK_ID} \
  --num-chunks 100 \
  --config configs/degradation/noisyshare_v2.yaml \
  --output-root data/degraded_test/

echo "End: $(date)"
