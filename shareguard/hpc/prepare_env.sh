#!/bin/bash
# Prepare ShareGuard environment on HPC

set -e

echo "=== Preparing ShareGuard Environment ==="

# Load modules
module purge
module load anaconda3/2024.06
module load cuda/12.1

# Create conda environment
conda create -n shareguard python=3.10 -y
conda activate shareguard

# Install PyTorch (adjust for your CUDA version)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# Install dependencies
pip install -r requirements.txt

# Install ShareGuard package
pip install -e .

echo "=== Environment Ready ==="
echo "Activate with: conda activate shareguard"
