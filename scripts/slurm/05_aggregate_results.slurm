#!/bin/bash
#SBATCH --partition=batch
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32GB
#SBATCH --time=0-02:00:00
#SBATCH --output=logs/aggregate_%j.out
#SBATCH --error=logs/aggregate_%j.err
#SBATCH --job-name=shareguard-aggregate

# Aggregate evaluation results and generate figures
# Usage: sbatch scripts/slurm/05_aggregate_results.slurm

set -e

source ~/.bashrc
conda activate shareguard

echo "=== Aggregating Results ==="
echo "Job ID: ${SLURM_JOB_ID}"
echo "Node: $(hostname)"
echo "Start: $(date)"

# Aggregate results
python -m shareguard.engine.aggregate_results \
  --input-dir outputs/results/ \
  --output-csv outputs/tables/main_results.csv

# Generate figures
python -m shareguard.analysis.plot_robustness \
  --input outputs/tables/main_results.csv \
  --output outputs/figures/robustness_curves.pdf

python -m shareguard.analysis.plot_risk_coverage \
  --input outputs/tables/main_results.csv \
  --output outputs/figures/risk_coverage.pdf

echo "End: $(date)"
