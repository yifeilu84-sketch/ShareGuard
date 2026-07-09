#!/bin/bash
# =============================================================================
# ShareGuard Pilot Experiment - SLURM Submission Script
# =============================================================================
# Usage:
#   sbatch scripts/hpc/run_pilot.slurm
#
#   # Override settings:
#   sbatch --partition=gpu_a100 scripts/hpc/run_pilot.slurm
#   sbatch --gres=gpu:2 scripts/hpc/run_pilot.slurm
#
# Partitions available on Burgundy:
#   - batch:       CPU only (for data preprocessing, manifest building)
#   - gpu_v100s:   NVIDIA V100 32GB (default for pilot, good for feature extraction)
#   - gpu_a100:    NVIDIA A100 40GB (for full training, larger batch sizes)
#   - gpu_a40:     NVIDIA A40 48GB (for large models, LoRA training)
# =============================================================================

#SBATCH --job-name=shareguard-pilot
#SBATCH --partition=gpu_v100s
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=80GB
#SBATCH --time=0-04:00:00
#SBATCH --output=logs/pilot_%j.out
#SBATCH --error=logs/pilot_%j.err
#SBATCH --mail-type=END,FAIL
#SBATCH --mail-user=yifeilu84@gmail.com

set -euo pipefail

echo "============================================"
echo " ShareGuard Pilot Experiment (SLURM)"
echo "============================================"
echo " Job ID:    ${SLURM_JOB_ID}"
echo " Node:      $(hostname)"
echo " Partition: ${SLURM_JOB_PARTITION}"
echo " GPUs:      ${CUDA_VISIBLE_DEVICES:-$(nvidia-smi -L 2>/dev/null | wc -l)}"
echo " CPUs:      ${SLURM_CPUS_PER_TASK}"
echo " Memory:    ${SLURM_MEM_PER_NODE}MB"
echo " Start:     $(date)"
echo "============================================"
echo ""

# Load environment
source ~/.bashrc 2>/dev/null || true
conda activate shareguard 2>/dev/null || source activate shareguard

# Set optimal CUDA settings for the allocated GPU
export CUDA_DEVICE_ORDER="PCI_BUS_ID"
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK}"

# Verify GPU
echo "GPU Info:"
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>/dev/null || echo "  (nvidia-smi not available)"
echo ""

# Change to project directory
cd "${HOME}/ShareGuard"

# Create log directory
mkdir -p logs outputs/pilot

# Run the pilot experiment
bash scripts/hpc/run_pilot.sh 2>&1 | tee "logs/pilot_${SLURM_JOB_ID}_detailed.log"

EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "============================================"
echo " Job Complete"
echo "============================================"
echo " Job ID:  ${SLURM_JOB_ID}"
echo " End:     $(date)"
echo " Exit:    ${EXIT_CODE}"
echo " Output:  outputs/pilot/"
echo " Logs:    logs/pilot_${SLURM_JOB_ID}.out"
echo "============================================"

exit ${EXIT_CODE}
