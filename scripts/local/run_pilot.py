"""
ShareGuard Pilot Experiment Script
===================================
Runs the complete pilot pipeline:
  Step 1: Build manifest from GenImage (10K subset)
  Step 2: Split into train/val/test
  Step 3: Apply degradations to test set (JPEG q50, share_medium)
  Step 4: Extract DINOv2 features for all splits + degraded sets
  Step 5: Train linear probe on cached features
  Step 6: Evaluate on clean + degraded test sets
  Step 7: Compute robustness drops and verify success criteria

Usage:
  python scripts/local/run_pilot.py --config configs/pilot/pilot_subset.yaml
  python scripts/local/run_pilot.py --config configs/pilot/pilot_subset.yaml --skip-extract  # if features already cached
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import yaml
from torch.utils.data import DataLoader
from tqdm import tqdm

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def log_step(step: str, msg: str):
    print(f"\n{'='*70}")
    print(f"[{step}] {msg}")
    print(f"{'='*70}")


# ──────────────────────────────────────────────────────────────────────
# Step 1: Build manifest and sample 10K subset
# ──────────────────────────────────────────────────────────────────────
def step1_build_subset(config: dict) -> Path:
    log_step("STEP 1", "Building 10K GenImage subset manifest")

    from shareguard.datasets.build_manifest import build_genimage_manifest

    cfg = config["data"]
    source_root = Path(cfg["source_root"])
    manifest_dir = Path(config["outputs"]["manifest_dir"])
    manifest_dir.mkdir(parents=True, exist_ok=True)

    # Check if full manifest already exists
    full_manifest_path = manifest_dir / "genimage_full.csv"
    if full_manifest_path.exists():
        print(f"  Loading existing full manifest from {full_manifest_path}")
        df_full = pd.read_csv(full_manifest_path)
    else:
        if not source_root.exists():
            print(f"  ERROR: GenImage root not found at {source_root}")
            print("  Please download GenImage first. See configs/data/genimage.yaml")
            sys.exit(1)
        df_full = build_genimage_manifest(source_root)
        df_full.to_csv(full_manifest_path, index=False)
        print(f"  Full manifest: {len(df_full)} images")

    # Filter to train generators only
    train_gens = cfg.get("train_generators", [])
    if train_gens:
        df_filtered = df_full[df_full["generator"].isin(train_gens)].copy()
        print(f"  Filtered to generators {train_gens}: {len(df_filtered)} images")
    else:
        df_filtered = df_full.copy()

    # Sample 10K with class balance
    subset_size = cfg.get("subset_size", 10000)
    if cfg.get("class_balance", True):
        n_per_class = subset_size // 2
        real_df = df_filtered[df_filtered["label"] == 0].sample(
            n=min(n_per_class, len(df_filtered[df_filtered["label"] == 0])),
            random_state=config["pilot"]["seed"]
        )
        fake_df = df_filtered[df_filtered["label"] == 1].sample(
            n=min(n_per_class, len(df_filtered[df_filtered["label"] == 1])),
            random_state=config["pilot"]["seed"]
        )
        df_subset = pd.concat([real_df, fake_df]).sample(
            frac=1, random_state=config["pilot"]["seed"]
        ).reset_index(drop=True)
    else:
        df_subset = df_filtered.sample(
            n=min(subset_size, len(df_filtered)),
            random_state=config["pilot"]["seed"]
        ).reset_index(drop=True)

    subset_path = manifest_dir / "genimage_pilot_10k.csv"
    df_subset.to_csv(subset_path, index=False)

    # Print statistics
    print(f"\n  Subset statistics:")
    print(f"    Total images: {len(df_subset)}")
    print(f"    Real: {(df_subset['label'] == 0).sum()}")
    print(f"    Fake: {(df_subset['label'] == 1).sum()}")
    print(f"    Generators: {df_subset['generator'].value_counts().to_dict()}")
    print(f"    Saved to: {subset_path}")

    return subset_path


# ──────────────────────────────────────────────────────────────────────
# Step 2: Split into train/val/test
# ──────────────────────────────────────────────────────────────────────
def step2_split(config: dict, subset_path: Path) -> tuple:
    log_step("STEP 2", "Splitting into train/val/test")

    from shareguard.datasets.split import split_manifest

    df = pd.read_csv(subset_path)
    split_cfg = config["split"]

    train_df, val_df, test_df = split_manifest(
        df,
        split_by=split_cfg.get("split_by", "source_id"),
        train_ratio=split_cfg.get("train_ratio", 0.70),
        val_ratio=split_cfg.get("val_ratio", 0.15),
        test_ratio=split_cfg.get("test_ratio", 0.15),
        seed=config["pilot"]["seed"],
    )

    manifest_dir = Path(config["outputs"]["manifest_dir"])
    train_path = manifest_dir / "pilot_train.csv"
    val_path = manifest_dir / "pilot_val.csv"
    test_path = manifest_dir / "pilot_test.csv"

    train_df.to_csv(train_path, index=False)
    val_df.to_csv(val_path, index=False)
    test_df.to_csv(test_path, index=False)

    train_real = len(train_df[train_df["label"] == 0])
    train_fake = len(train_df[train_df["label"] == 1])
    val_real = len(val_df[val_df["label"] == 0])
    val_fake = len(val_df[val_df["label"] == 1])
    test_real = len(test_df[test_df["label"] == 0])
    test_fake = len(test_df[test_df["label"] == 1])
    print(f"  Train: {len(train_df)} images (real={train_real}, fake={train_fake})")
    print(f"  Val:   {len(val_df)} images (real={val_real}, fake={val_fake})")
    print(f"  Test:  {len(test_df)} images (real={test_real}, fake={test_fake})")

    return train_path, val_path, test_path


# ──────────────────────────────────────────────────────────────────────
# Step 3: Apply degradations to test set
# ──────────────────────────────────────────────────────────────────────
def step3_apply_degradations(config: dict, test_path: Path) -> dict:
    log_step("STEP 3", "Applying degradations to test set")

    from shareguard.degradations.compose import get_degradation, apply_degradation_to_manifest

    degraded_dir = Path(config["outputs"]["degraded_dir"])
    degraded_dir.mkdir(parents=True, exist_ok=True)

    degraded_manifests = {}

    for deg_cfg in config["degradations"]:
        deg_name = deg_cfg["name"]
        desc = deg_cfg.get("description", deg_name)
        print(f"\n  Applying degradation: {deg_name} ({desc})")

        degradation = get_degradation(deg_name)
        out_dir = degraded_dir / deg_name
        out_manifest = degraded_dir / f"pilot_test_{deg_name}.csv"

        if out_manifest.exists():
            print(f"    Already exists at {out_manifest}, skipping generation.")
        else:
            apply_degradation_to_manifest(
                manifest_path=str(test_path),
                degradation=degradation,
                output_root=str(out_dir),
                output_manifest=str(out_manifest),
                overwrite=False,
            )

        degraded_manifests[deg_name] = str(out_manifest)

        # Quick sanity check
        df_deg = pd.read_csv(out_manifest)
        print(f"    Degraded manifest: {len(df_deg)} images")

    return degraded_manifests


# ──────────────────────────────────────────────────────────────────────
# Step 4: Extract DINOv2 features
# ──────────────────────────────────────────────────────────────────────
def step4_extract_features(config: dict, manifests: dict) -> dict:
    log_step("STEP 4", "Extracting DINOv2 features (frozen)")

    from shareguard.models.backbones import get_backbone
    from shareguard.datasets.dataset import NoisyShareDataset, get_default_transform

    feature_dir = Path(config["outputs"]["feature_dir"])
    feature_dir.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"  Device: {device}")

    # Load backbone
    backbone_name = config["model"]["backbone"]
    print(f"  Loading backbone: {backbone_name}")
    backbone = get_backbone(backbone_name, freeze=True)
    backbone = backbone.to(device)
    backbone.eval()

    transform = get_default_transform(
        config["training"]["image_size"],
        backbone="dinov2"
    )

    feature_paths = {}

    for split_name, manifest_path in manifests.items():
        feat_path = feature_dir / f"{split_name}_features.pt"

        if feat_path.exists():
            print(f"\n  Features for {split_name} already cached at {feat_path}")
            feature_paths[split_name] = str(feat_path)
            continue

        print(f"\n  Extracting features for: {split_name}")
        print(f"    Manifest: {manifest_path}")

        dataset = NoisyShareDataset(
            manifest_path=manifest_path,
            transform=transform,
        )
        loader = DataLoader(
            dataset,
            batch_size=config["training"].get("batch_size", 64),
            shuffle=False,
            num_workers=4,
            pin_memory=True,
        )

        all_features = []
        all_labels = []

        with torch.no_grad():
            for images, labels in tqdm(loader, desc=f"    {split_name}"):
                images = images.to(device)
                features = backbone(images)
                all_features.append(features.cpu())
                all_labels.append(labels)

        features_tensor = torch.cat(all_features, dim=0)
        labels_tensor = torch.cat(all_labels, dim=0)

        torch.save({
            "features": features_tensor,
            "labels": labels_tensor,
        }, feat_path)

        print(f"    Saved {features_tensor.shape[0]} features (dim={features_tensor.shape[1]}) to {feat_path}")
        feature_paths[split_name] = str(feat_path)

    return feature_paths


# ──────────────────────────────────────────────────────────────────────
# Step 5: Train linear probe
# ──────────────────────────────────────────────────────────────────────
def step5_train(config: dict, feature_paths: dict) -> str:
    log_step("STEP 5", "Training DINOv2 frozen linear probe")

    from shareguard.engine.train import train_linear_probe
    from shareguard.utils.seed import set_seed

    set_seed(config["pilot"]["seed"])

    # Load features
    train_data = torch.load(feature_paths["train"], map_location="cpu")
    val_data = torch.load(feature_paths["val"], map_location="cpu")

    train_features = train_data["features"]
    train_labels = train_data["labels"].float()
    val_features = val_data["features"]
    val_labels = val_data["labels"].float()

    print(f"  Train features: {train_features.shape}")
    print(f"  Val features:   {val_features.shape}")

    # Training config
    train_cfg = {
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "num_classes": config["model"]["num_classes"],
        "dropout": config["model"]["dropout"],
        "lr": config["training"]["lr"],
        "weight_decay": config["training"]["weight_decay"],
        "batch_size": config["training"]["batch_size"],
        "epochs": config["training"]["epochs"],
        "patience": config["training"]["patience"],
    }

    model = train_linear_probe(
        train_features, train_labels,
        val_features, val_labels,
        train_cfg,
    )

    # Save checkpoint
    ckpt_dir = Path(config["outputs"]["checkpoint_dir"])
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    ckpt_path = ckpt_dir / "dinov2_linear_pilot_best.pt"

    torch.save({
        "model_state_dict": model.state_dict(),
        "config": {**config["model"], **config["training"]},
        "feat_dim": train_features.shape[1],
    }, ckpt_path)

    print(f"\n  Checkpoint saved to: {ckpt_path}")
    return str(ckpt_path)


# ──────────────────────────────────────────────────────────────────────
# Step 6: Evaluate on clean + degraded
# ──────────────────────────────────────────────────────────────────────
def step6_evaluate(config: dict, checkpoint_path: str, feature_paths: dict) -> dict:
    log_step("STEP 6", "Evaluating on clean + degraded test sets")

    from shareguard.models.linear_probe import LinearProbe
    from shareguard.engine.metrics import compute_metrics

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load model
    checkpoint = torch.load(checkpoint_path, map_location=device)
    feat_dim = checkpoint["feat_dim"]
    model = LinearProbe(in_dim=feat_dim, num_classes=1)
    model.load_state_dict(checkpoint["model_state_dict"])
    model = model.to(device)
    model.eval()

    results = {}

    for split_name, feat_path in feature_paths.items():
        if split_name in ("train", "val"):
            continue  # Only evaluate on test sets

        data = torch.load(feat_path, map_location="cpu")
        features = data["features"].to(device)
        labels = data["labels"].numpy()

        with torch.no_grad():
            logits = model(features).squeeze(-1)
            probs = torch.sigmoid(logits).cpu().numpy()

        metrics = compute_metrics(labels, probs)
        results[split_name] = metrics

        print(f"\n  {split_name}:")
        for k, v in metrics.items():
            print(f"    {k}: {v:.4f}")

    return results


# ──────────────────────────────────────────────────────────────────────
# Step 7: Analyze robustness drops and check success criteria
# ──────────────────────────────────────────────────────────────────────
def step7_analyze(config: dict, results: dict) -> dict:
    log_step("STEP 7", "Analyzing robustness drops")

    from shareguard.engine.metrics import compute_robustness_drops, format_metrics_table
    from shareguard.analysis.robustness_drop import analyze_robustness_drop, plot_robustness_bars

    # Print metrics table
    print("\n  Full results table:")
    print(format_metrics_table(results))

    # Compute robustness drops
    clean_metrics = results.get("clean", results.get("test"))
    degraded_metrics = {k: v for k, v in results.items() if k not in ("clean", "test", "train", "val")}

    drops = compute_robustness_drops(clean_metrics, degraded_metrics)
    print(f"\n  Robustness drops (AUC):")
    for deg_name, drop in drops.items():
        print(f"    {deg_name}: {drop:.4f}")

    # Analyze and plot
    results_dir = Path(config["outputs"]["results_dir"])
    figures_dir = Path(config["outputs"]["figures_dir"])
    results_dir.mkdir(parents=True, exist_ok=True)
    figures_dir.mkdir(parents=True, exist_ok=True)

    # Build results dict for analysis (include clean)
    analysis_results = {"clean": clean_metrics}
    analysis_results.update(degraded_metrics)

    drop_df = analyze_robustness_drop(
        analysis_results,
        metric="auc",
        output_path=str(figures_dir / "pilot_robustness_drop.png"),
    )
    print(f"\n  Robustness drop analysis:")
    print(drop_df.to_string(index=False))

    # Save results
    results_df = pd.DataFrame(analysis_results).T
    results_df.to_csv(results_dir / "pilot_metrics.csv")

    # Save summary
    summary = {
        "clean_auc": clean_metrics["auc"],
        "drops": drops,
        "all_results": {k: {mk: float(mv) for mk, mv in v.items()} for k, v in results.items()},
    }
    with open(results_dir / "pilot_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\n  Results saved to: {results_dir}")
    print(f"  Figure saved to:  {figures_dir / 'pilot_robustness_drop.png'}")

    # Check success criteria
    success = check_success_criteria(config, clean_metrics, drops)

    return {"drops": drops, "success": success, "summary": summary}


def check_success_criteria(config: dict, clean_metrics: dict, drops: dict) -> dict:
    """Check if pilot meets success criteria."""
    print(f"\n{'='*70}")
    print("SUCCESS CRITERIA CHECK")
    print(f"{'='*70}")

    criteria = config.get("success", {})
    checks = {}

    # Check 1: Clean AUC >= threshold
    min_clean = criteria.get("min_clean_auc", 0.85)
    clean_auc = clean_metrics["auc"]
    checks["clean_auc_sufficient"] = clean_auc >= min_clean
    status = "PASS" if checks["clean_auc_sufficient"] else "FAIL"
    print(f"  [{status}] Clean AUC {clean_auc:.4f} >= {min_clean}")

    # Check 2: Clean AUC not too high (subset not trivial)
    max_clean = criteria.get("max_acceptable_clean_auc", 0.99)
    checks["clean_auc_not_trivial"] = clean_auc <= max_clean
    status = "PASS" if checks["clean_auc_not_trivial"] else "WARN"
    print(f"  [{status}] Clean AUC {clean_auc:.4f} <= {max_clean} (not trivially easy)")

    # Check 3: JPEG q50 robustness drop
    jpeg_drop_key = None
    for k in drops:
        if "jpeg" in k.lower() or "q50" in k.lower():
            jpeg_drop_key = k
            break

    if jpeg_drop_key:
        min_jpeg_drop = criteria.get("min_robustness_drop_jpeg_q50", 0.03)
        jpeg_drop = drops[jpeg_drop_key]
        checks["jpeg_q50_drop_exists"] = jpeg_drop >= min_jpeg_drop
        status = "PASS" if checks["jpeg_q50_drop_exists"] else "FAIL"
        print(f"  [{status}] JPEG q50 drop {jpeg_drop:.4f} >= {min_jpeg_drop}")
    else:
        checks["jpeg_q50_drop_exists"] = False
        print(f"  [SKIP] JPEG q50 degradation not found in results")

    # Check 4: Compound robustness drop
    compound_drop_key = None
    for k in drops:
        if "compound" in k.lower() or "medium" in k.lower() or "share" in k.lower():
            compound_drop_key = k
            break

    if compound_drop_key:
        min_compound_drop = criteria.get("min_robustness_drop_share_medium", 0.05)
        compound_drop = drops[compound_drop_key]
        checks["compound_drop_exists"] = compound_drop >= min_compound_drop
        status = "PASS" if checks["compound_drop_exists"] else "FAIL"
        print(f"  [{status}] Compound drop {compound_drop:.4f} >= {min_compound_drop}")
    else:
        checks["compound_drop_exists"] = False
        print(f"  [SKIP] Compound degradation not found in results")

    # Overall
    all_passed = all(checks.values())
    print(f"\n  Overall: {'ALL CHECKS PASSED' if all_passed else 'SOME CHECKS FAILED'}")

    if all_passed:
        print("  The robustness drop phenomenon is CONFIRMED.")
        print("  Proceed to full-scale experiments.")
    else:
        print("  Review failures before proceeding.")
        if not checks.get("clean_auc_sufficient", True):
            print("  -> Clean AUC too low: check data quality or training config")
        if not checks.get("clean_auc_not_trivial", True):
            print("  -> Clean AUC suspiciously high: subset may be too easy, increase diversity")
        if not checks.get("jpeg_q50_drop_exists", True):
            print("  -> JPEG drop too small: try lower quality (q30) or check degradation pipeline")
        if not checks.get("compound_drop_exists", True):
            print("  -> Compound drop too small: try heavier degradation or check pipeline")

    checks["overall"] = all_passed
    return checks


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="ShareGuard Pilot Experiment")
    parser.add_argument("--config", type=str, default="configs/pilot/pilot_subset.yaml",
                        help="Pilot config YAML")
    parser.add_argument("--skip-build", action="store_true",
                        help="Skip manifest building (use existing)")
    parser.add_argument("--skip-degradation", action="store_true",
                        help="Skip degradation generation (use existing)")
    parser.add_argument("--skip-extract", action="store_true",
                        help="Skip feature extraction (use cached)")
    parser.add_argument("--skip-train", action="store_true",
                        help="Skip training (use existing checkpoint)")
    parser.add_argument("--start-from", type=int, default=1,
                        help="Start from step N (1-7)")
    args = parser.parse_args()

    config = load_config(args.config)

    print(f"\n{'#'*70}")
    print(f"# ShareGuard Pilot Experiment: {config['pilot']['name']}")
    print(f"# {config['pilot']['description']}")
    print(f"# Seed: {config['pilot']['seed']}")
    print(f"{'#'*70}")

    start_time = time.time()

    # Step 1: Build subset
    if args.start_from <= 1 and not args.skip_build:
        subset_path = step1_build_subset(config)
    else:
        subset_path = Path(config["outputs"]["manifest_dir"]) / "genimage_pilot_10k.csv"

    # Step 2: Split
    if args.start_from <= 2:
        train_path, val_path, test_path = step2_split(config, subset_path)
    else:
        manifest_dir = Path(config["outputs"]["manifest_dir"])
        train_path = manifest_dir / "pilot_train.csv"
        val_path = manifest_dir / "pilot_val.csv"
        test_path = manifest_dir / "pilot_test.csv"

    # Step 3: Apply degradations
    if args.start_from <= 3 and not args.skip_degradation:
        degraded_manifests = step3_apply_degradations(config, test_path)
    else:
        degraded_dir = Path(config["outputs"]["degraded_dir"])
        degraded_manifests = {}
        for deg_cfg in config["degradations"]:
            name = deg_cfg["name"]
            path = degraded_dir / f"pilot_test_{name}.csv"
            if path.exists():
                degraded_manifests[name] = str(path)

    # Step 4: Extract features
    all_manifests = {
        "train": str(train_path),
        "val": str(val_path),
        "test": str(test_path),
    }
    all_manifests.update(degraded_manifests)

    if args.start_from <= 4 and not args.skip_extract:
        feature_paths = step4_extract_features(config, all_manifests)
    else:
        feature_dir = Path(config["outputs"]["feature_dir"])
        feature_paths = {}
        for name in all_manifests:
            feat_path = feature_dir / f"{name}_features.pt"
            if feat_path.exists():
                feature_paths[name] = str(feat_path)

    # Step 5: Train
    if args.start_from <= 5 and not args.skip_train:
        checkpoint_path = step5_train(config, feature_paths)
    else:
        checkpoint_path = str(
            Path(config["outputs"]["checkpoint_dir"]) / "dinov2_linear_pilot_best.pt"
        )

    # Step 6: Evaluate
    if args.start_from <= 6:
        results = step6_evaluate(config, checkpoint_path, feature_paths)
    else:
        results = {}

    # Step 7: Analyze
    if args.start_from <= 7 and results:
        analysis = step7_analyze(config, results)

    elapsed = time.time() - start_time
    print(f"\n{'#'*70}")
    print(f"# Pilot experiment completed in {elapsed/60:.1f} minutes")
    print(f"{'#'*70}")


if __name__ == "__main__":
    main()
