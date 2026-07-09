#!/bin/bash
#SBATCH --partition=gpu_v100s
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=80GB
#SBATCH --time=0-04:00:00
#SBATCH --array=0-199
#SBATCH --output=logs/eval_%A_%a.out
#SBATCH --error=logs/eval_%A_%a.err
#SBATCH --job-name=shareguard-eval

# Run evaluation across model/dataset/degradation grid
# Usage: sbatch scripts/slurm/04_eval_array.slurm

set -e

source ~/.bashrc
conda activate shareguard

echo "=== Running Evaluation ==="
echo "Job ID: ${SLURM_ARRAY_JOB_ID}"
echo "Task ID: ${SLURM_ARRAY_TASK_ID}"
echo "GPU: ${CUDA_VISIBLE_DEVICES}"
echo "Node: $(hostname)"
echo "Start: $(date)"

python -m shareguard.engine.evaluate_from_grid \
  --grid configs/eval/eval_grid.yaml \
  --job-index ${SLURM_ARRAY_TASK_ID} \
  --output-dir outputs/results/

echo "End: $(date)"
