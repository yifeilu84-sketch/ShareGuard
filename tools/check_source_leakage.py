"""Check for source image leakage between train/val/test splits."""

import argparse
import pandas as pd
from pathlib import Path
from typing import Dict, List, Set, Tuple


def extract_source_id(image_path: str) -> str:
    """Extract source ID from image path."""
    path = Path(image_path)
    stem = path.stem
    for suffix in ["_real", "_fake", "_ai", "_gen", "_synth"]:
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem


def check_source_leakage(
    train_manifest: str,
    val_manifest: str,
    test_manifest: str = None,
) -> Dict:
    """Check for source image leakage between splits.

    Returns:
        Dict with leakage statistics and details.
    """
    train_df = pd.read_csv(train_manifest)
    val_df = pd.read_csv(val_manifest)

    # Extract source IDs
    train_sources = set(train_df["image_path"].apply(extract_source_id))
    val_sources = set(val_df["image_path"].apply(extract_source_id))

    # Check train/val leakage
    train_val_leakage = train_sources & val_sources

    result = {
        "train_manifest": train_manifest,
        "val_manifest": val_manifest,
        "train_size": len(train_df),
        "val_size": len(val_df),
        "train_unique_sources": len(train_sources),
        "val_unique_sources": len(val_sources),
        "train_val_leakage_count": len(train_val_leakage),
        "train_val_leakage_sources": list(train_val_leakage)[:20],  # First 20
        "has_leakage": len(train_val_leakage) > 0,
    }

    if test_manifest:
        test_df = pd.read_csv(test_manifest)
        test_sources = set(test_df["image_path"].apply(extract_source_id))

        train_test_leakage = train_sources & test_sources
        val_test_leakage = val_sources & test_sources

        result.update({
            "test_manifest": test_manifest,
            "test_size": len(test_df),
            "test_unique_sources": len(test_sources),
            "train_test_leakage_count": len(train_test_leakage),
            "val_test_leakage_count": len(val_test_leakage),
            "train_test_leakage_sources": list(train_test_leakage)[:20],
            "val_test_leakage_sources": list(val_test_leakage)[:20],
            "has_leakage": result["has_leakage"] or len(train_test_leakage) > 0 or len(val_test_leakage) > 0,
        })

    return result


def check_generator_leakage(manifest: str) -> Dict:
    """Check if same generator appears in multiple splits."""
    df = pd.read_csv(manifest)

    if "generator" not in df.columns or "split" not in df.columns:
        return {"error": "Missing generator or split column"}

    generators_per_split = df.groupby("split")["generator"].apply(set).to_dict()

    # Check overlap
    splits = list(generators_per_split.keys())
    overlaps = {}
    for i, split1 in enumerate(splits):
        for split2 in splits[i+1:]:
            overlap = generators_per_split[split1] & generators_per_split[split2]
            if overlap:
                overlaps[f"{split1}_vs_{split2}"] = list(overlap)

    return {
        "manifest": manifest,
        "generators_per_split": {k: list(v) for k, v in generators_per_split.items()},
        "overlaps": overlaps,
        "has_generator_leakage": len(overlaps) > 0,
    }


def main():
    parser = argparse.ArgumentParser(description="Check source leakage")
    parser.add_argument("--train", type=str, required=True, help="Train manifest")
    parser.add_argument("--val", type=str, required=True, help="Val manifest")
    parser.add_argument("--test", type=str, default=None, help="Test manifest")
    parser.add_argument("--output", type=str, default="reports/leakage_report.csv")
    args = parser.parse_args()

    result = check_source_leakage(args.train, args.val, args.test)

    print("=== Source Leakage Report ===")
    print(f"Train: {result['train_size']} images, {result['train_unique_sources']} sources")
    print(f"Val: {result['val_size']} images, {result['val_unique_sources']} sources")
    if args.test:
        print(f"Test: {result['test_size']} images, {result['test_unique_sources']} sources")
    print(f"Train/Val leakage: {result['train_val_leakage_count']} sources")
    if args.test:
        print(f"Train/Test leakage: {result['train_test_leakage_count']} sources")
        print(f"Val/Test leakage: {result['val_test_leakage_count']} sources")
    print(f"Has leakage: {result['has_leakage']}")

    # Save report
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame([result]).to_csv(args.output, index=False)
    print(f"Report saved to {args.output}")


if __name__ == "__main__":
    main()
