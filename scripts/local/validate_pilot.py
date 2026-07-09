"""
Quick validation script for pilot experiment outputs.
Checks that all expected files exist and success criteria are met.

Usage:
  python scripts/local/validate_pilot.py --config configs/pilot/pilot_subset.yaml
"""

import argparse
import json
import sys
from pathlib import Path

import yaml
import pandas as pd


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def check_file(path, description):
    exists = Path(path).exists()
    status = "OK" if exists else "MISSING"
    print(f"  [{status}] {description}: {path}")
    return exists


def main():
    parser = argparse.ArgumentParser(description="Validate pilot outputs")
    parser.add_argument("--config", type=str, default="configs/pilot/pilot_subset.yaml")
    args = parser.parse_args()

    config = load_config(args.config)

    print("=" * 60)
    print("PILOT OUTPUT VALIDATION")
    print("=" * 60)

    all_ok = True

    # 1. Check manifests
    print("\n1. Manifests:")
    manifest_dir = Path(config["outputs"]["manifest_dir"])
    for name in ["pilot_train.csv", "pilot_val.csv", "pilot_test.csv"]:
        path = manifest_dir / name
        if check_file(path, name):
            df = pd.read_csv(path)
            print(f"       -> {len(df)} images, labels: {df['label'].value_counts().to_dict()}")
        else:
            all_ok = False

    # 2. Check degraded manifests
    print("\n2. Degraded manifests:")
    degraded_dir = Path(config["outputs"]["degraded_dir"])
    for deg_cfg in config["degradations"]:
        name = deg_cfg["name"]
        path = degraded_dir / f"pilot_test_{name}.csv"
        if check_file(path, f"pilot_test_{name}.csv"):
            df = pd.read_csv(path)
            print(f"       -> {len(df)} images")
        else:
            all_ok = False

    # 3. Check features
    print("\n3. Cached features:")
    feature_dir = Path(config["outputs"]["feature_dir"])
    expected_features = ["train_features.pt", "val_features.pt", "test_features.pt"]
    for deg_cfg in config["degradations"]:
        expected_features.append(f"{deg_cfg['name']}_features.pt")

    for name in expected_features:
        path = feature_dir / name
        if check_file(path, name):
            import torch
            data = torch.load(path, map_location="cpu")
            print(f"       -> features: {data['features'].shape}, labels: {data['labels'].shape}")
        else:
            all_ok = False

    # 4. Check checkpoint
    print("\n4. Model checkpoint:")
    ckpt_path = Path(config["outputs"]["checkpoint_dir"]) / "dinov2_linear_pilot_best.pt"
    check_file(ckpt_path, "dinov2_linear_pilot_best.pt")

    # 5. Check results
    print("\n5. Results:")
    results_dir = Path(config["outputs"]["results_dir"])
    check_file(results_dir / "pilot_metrics.csv", "pilot_metrics.csv")
    check_file(results_dir / "pilot_summary.json", "pilot_summary.json")

    # 6. Check figures
    print("\n6. Figures:")
    figures_dir = Path(config["outputs"]["figures_dir"])
    check_file(figures_dir / "pilot_robustness_drop.png", "robustness drop plot")

    # 7. Check success criteria
    summary_path = results_dir / "pilot_summary.json"
    if summary_path.exists():
        print("\n7. Success criteria:")
        with open(summary_path) as f:
            summary = json.load(f)

        clean_auc = summary.get("clean_auc", 0)
        drops = summary.get("drops", {})
        criteria = config.get("success", {})

        min_clean = criteria.get("min_clean_auc", 0.85)
        status = "PASS" if clean_auc >= min_clean else "FAIL"
        print(f"  [{status}] Clean AUC: {clean_auc:.4f} (min: {min_clean})")

        for deg_name, drop in drops.items():
            min_drop = criteria.get(f"min_robustness_drop_{deg_name}", 0.03)
            status = "PASS" if drop >= min_drop else "FAIL"
            print(f"  [{status}] {deg_name} drop: {drop:.4f} (min: {min_drop})")
    else:
        print("\n7. Success criteria: SKIPPED (no summary file)")

    print("\n" + "=" * 60)
    if all_ok:
        print("ALL OUTPUTS PRESENT - Pilot experiment complete.")
    else:
        print("SOME OUTPUTS MISSING - Run the pilot experiment first.")
    print("=" * 60)


if __name__ == "__main__":
    main()
