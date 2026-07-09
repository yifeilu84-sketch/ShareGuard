# ShareGuard

**Degradation-Invariant and Uncertainty-Aware Detection of AI-Generated Images in Real-World Sharing Pipelines**

面向真实传播链路的退化不变与不确定性感知AI生成图像检测

## Overview

ShareGuard is a comprehensive framework for robust AI-generated image detection under real-world sharing degradations. It includes:

1. **NoisyShareBench-v2**: A large-scale benchmark covering single, compound, platform-inspired, and hard sharing degradations
2. **ShareGuard**: A degradation-invariant and uncertainty-aware detection framework
3. **Reliability evaluation**: Calibration, risk-coverage, and selective prediction

## Key Features

- **Multi-view sharing simulation**: Simulate real-world propagation (JPEG, resize, crop, screenshot, meme, platform-specific)
- **Degradation-invariant learning**: Contrastive learning to align features across degradations
- **Generator debiasing**: Adversarial training to prevent generator-specific overfitting
- **Uncertainty estimation**: Multi-view variance as uncertainty signal for selective prediction
- **HPC-ready**: SLURM scripts for parallel experiments on CityUHK Burgundy

## Project Structure

```
ShareGuard/
├── configs/           # YAML configurations
│   ├── data/          # Dataset configs
│   ├── degradation/   # Degradation pipeline configs
│   ├── model/         # Model architecture configs
│   ├── train/         # Training configs
│   ├── eval/          # Evaluation grid configs
│   └── slurm/         # SLURM job configs
├── shareguard/        # Main package
│   ├── datasets/      # Data loading and manifests
│   ├── degradations/  # Degradation pipelines
│   ├── models/        # Encoders, ShareGuard, adapters, LoRA
│   ├── losses/        # Classification, contrastive, adversarial, calibration
│   ├── engine/        # Training, evaluation, inference
│   ├── analysis/      # Visualization and statistics
│   ├── hpc/           # HPC utilities
│   └── utils/         # IO, seed, logging
├── scripts/
│   ├── slurm/         # SLURM array job scripts
│   └── local/         # Local scripts
├── data/              # Data manifests and cached features
├── outputs/           # Checkpoints, logs, tables, figures
└── paper/             # LaTeX source
```

## Quick Start

### 1. Environment Setup (HPC)

```bash
# On CityUHK Burgundy
source shareguard/hpc/prepare_env.sh

# Or locally
conda create -n shareguard python=3.10
conda activate shareguard
pip install -r requirements.txt
pip install -e .
```

### 2. Data Preparation

```bash
# Build manifests
python -m shareguard.datasets.build_manifest \
  --dataset genimage \
  --root data/raw/GenImage \
  --output data/manifests/genimage_all.csv

# Split by source_id (prevents leakage)
python -m shareguard.datasets.split \
  --input data/manifests/genimage_all.csv \
  --split_by source_id \
  --train_generators sd_v1,adm,glide \
  --test_generators midjourney,dalle,sdxl \
  --output_dir data/manifests/
```

### 3. Generate Degradations (HPC)

```bash
# Split manifest into chunks
python -m shareguard.hpc.make_chunks \
  --manifest data/manifests/test_clean.csv \
  --num-chunks 100 \
  --output-dir data/manifests/chunks/

# Submit SLURM array job
sbatch scripts/slurm/01_generate_degradation_array.slurm
```

### 4. Extract Features (HPC)

```bash
sbatch scripts/slurm/02_extract_features_array.slurm
```

### 5. Train ShareGuard (HPC)

```bash
sbatch scripts/slurm/03_train_shareguard.slurm
```

### 6. Evaluate (HPC)

```bash
sbatch scripts/slurm/04_eval_array.slurm
```

### 7. Aggregate Results

```bash
sbatch scripts/slurm/05_aggregate_results.slurm
```

## Model Architecture

### ShareGuard

```
Input image
   ↓
K-view sharing simulation (K=4 train, K=8 test)
   ↓
Vision encoder: CLIP / DINOv2 / SigLIP (frozen/adapter/LoRA)
   ↓
Semantic feature aggregation (mean + std + max)
   ↓
Frequency residual branch (FFT radial features)
   ↓
Fusion classifier (MLP)
   ↓
Uncertainty estimation (view variance)
   ↓
Output: real / fake / uncertain
```

### Loss Function

```
L_total = L_cls + λ1 L_inv + λ2 L_cons + λ3 L_gen_adv + λ4 L_cal

L_cls: Binary classification loss
L_inv: Degradation-invariant contrastive loss
L_cons: Prediction consistency loss
L_gen_adv: Generator debias adversarial loss
L_cal: Calibration loss
```

## Evaluation Metrics

- **AUC**: Primary metric
- **Robustness Drop**: AUC_clean - AUC_degraded
- **ECE**: Expected Calibration Error
- **AURC**: Area Under Risk-Coverage Curve
- **Failure AUROC**: How well uncertainty predicts errors

## Backbone Modes

1. **Frozen**: Only train classifier head (fastest, baseline)
2. **Adapter**: Insert lightweight adapters (recommended)
3. **LoRA**: Low-rank adaptation of attention layers (best quality)

## Citation

```bibtex
@inproceedings{shareguard2027,
  title={ShareGuard: Degradation-Invariant and Uncertainty-Aware Detection of AI-Generated Images in Real-World Sharing Pipelines},
  author={},
  booktitle={CVPR},
  year={2027}
}
```

## Acknowledgement

This work was carried out using the computational facilities, CityUHK Burgundy, managed and provided by the Computing Services Centre at City University of Hong Kong.

## License

TBD
