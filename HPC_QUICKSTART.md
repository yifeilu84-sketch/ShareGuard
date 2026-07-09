# ShareGuard HPC Quick Start Guide

CityUHK Burgundy HPC Deployment Guide

## Prerequisites

1. CityUHK Burgundy HPC account
2. SSH access to HPC
3. Basic familiarity with SLURM

## Cluster Resources

| Resource | Location | Capacity | Purpose |
|----------|----------|----------|---------|
| Home | `~` | ~50GB | Code, conda env, configs |
| Scratch | `$SCRATCH` | ~300GB | Raw data, manifests, features |
| Local | `/local` | ~350GB | Fast temp I/O (job-scoped, ephemeral) |

### GPU Partitions

| Partition | GPU | Memory | Best For |
|-----------|-----|--------|----------|
| `gpu_v100s` | NVIDIA V100 | 32GB | Pilot, feature extraction |
| `gpu_a100` | NVIDIA A100 | 40GB | Full training, larger batches |
| `gpu_a40` | NVIDIA A40 | 48GB | LoRA, large models |
| `batch` | CPU only | - | Data preprocessing, manifests |

## Step 1: Connect to HPC

```bash
ssh your_username@burgundy.hpc.cityu.edu.hk
```

## Step 2: Upload Code

From your local machine:

```bash
# Option A: scp (simple)
scp -r C:\Users\lenovo\ShareGuard your_username@burgundy.hpc.cityu.edu.hk:~/

# Option B: rsync (recommended, supports resume)
rsync -avz --progress C:\Users\lenovo\ShareGuard your_username@burgundy.hpc.cityu.edu.hk:~/
```

## Step 3: Validate Environment

```bash
cd ~/ShareGuard
bash scripts/hpc/validate_setup.sh --quick
```

This checks HPC modules, disk space, and project structure before installing anything.

## Step 4: Setup Environment

```bash
bash scripts/hpc/setup_environment.sh
```

This will:
1. Load anaconda3 and cuda modules
2. Create conda env `shareguard` with Python 3.10
3. Install PyTorch 2.1 + CUDA 12.1
4. Install all dependencies from requirements.txt
5. Install ShareGuard as editable package
6. Verify all packages

## Step 5: Validate Installation

```bash
bash scripts/hpc/validate_setup.sh
```

This runs a comprehensive check including a GPU smoke test with DINOv2.

## Step 6: Download Data

```bash
# Small test download (~5GB, 2 generators)
bash scripts/hpc/download_genimage.sh --small

# Full dataset (~200GB, all 7 generators)
bash scripts/hpc/download_genimage.sh
```

Data goes to `$SCRATCH/ShareGuard/data/raw/GenImage`.

If automatic download fails, the script provides manual instructions.

## Step 7: Run Pilot Experiment

### Option A: SLURM batch (recommended)

```bash
sbatch scripts/hpc/run_pilot.slurm
```

### Option B: Interactive GPU session

```bash
srun --partition=gpu_v100s --gres=gpu:1 --cpus-per-task=8 --mem=80GB --time=04:00:00 --pty bash
cd ~/ShareGuard
bash scripts/hpc/run_pilot.sh
```

### Option C: Custom settings

```bash
PILOT_SIZE=5000 EPOCHS=10 sbatch scripts/hpc/run_pilot.slurm
```

## Step 8: Check Results

```bash
# Job status
squeue -u $USER

# Output logs
cat logs/pilot_<JOB_ID>.out

# Results JSON
cat outputs/pilot/pilot_results.json

# Key metric: val AUC should be > 0.90
python -c "import json; r=json.load(open('outputs/pilot/pilot_results.json')); print(f'Val AUC: {r[\"best_val_auc\"]:.4f}')"
```

## Next Steps: Full Pipeline

After pilot succeeds, run the full experiment pipeline:

```bash
# 1. Generate degraded test images (array job)
python -m shareguard.hpc.make_chunks --manifest data/manifests/test_clean.csv --num-chunks 100 --output-dir data/manifests/chunks/
sbatch scripts/slurm/01_generate_degradation_array.slurm

# 2. Extract features (array job)
sbatch scripts/slurm/02_extract_features_array.slurm

# 3. Train ShareGuard
sbatch scripts/slurm/03_train_shareguard.slurm

# 4. Evaluate (array job)
sbatch scripts/slurm/04_eval_array.slurm

# 5. Aggregate results
sbatch scripts/slurm/05_aggregate_results.slurm
```

## Common SLURM Commands

```bash
sinfo                              # Partition info
sinfo -o "%P %G %A"               # GPU availability
squeue -u $USER                    # Your jobs
scontrol show job <JOB_ID>         # Job details
scancel <JOB_ID>                   # Cancel job
scancel -u $USER                   # Cancel all your jobs
sacct -u $USER --format=JobID,JobName,State,Elapsed  # Job history
```

## Troubleshooting

### Conda activation fails
```bash
source ~/.bashrc
conda init bash
source ~/.bashrc
conda activate shareguard
```

### CUDA not available
```bash
module load cuda/12.1
python -c "import torch; print(torch.cuda.is_available())"
```

### Out of memory
Switch to a larger partition or reduce batch size:
```bash
#SBATCH --partition=gpu_a100
#SBATCH --mem=100GB
```
Or set: `BATCH_SIZE=128 sbatch scripts/hpc/run_pilot.slurm`

### Job times out
Increase time limit:
```bash
#SBATCH --time=1-00:00:00   # 1 day
```

### Scratch files cleaned up
Scratch is periodically purged of unused files. Keep important results in home:
```bash
cp -r $SCRATCH/ShareGuard/outputs/pilot ~/ShareGuard/outputs/
```

## Support

- HPC Support: csc_support@cityu.edu.hk
- HPC Docs: https://www.cityu.edu.hk/hpc/
