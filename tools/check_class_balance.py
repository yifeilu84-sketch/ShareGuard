"""Check class balance in manifests."""

import argparse
import pandas as pd
from pathlib import Path


def check_class_balance(manifest_path: str) -> dict:
    """Check class balance in a manifest."""
    df = pd.read_csv(manifest_path)

    result = {
        "manifest": manifest_path,
        "total": len(df),
    }

    if "label" in df.columns:
        label_counts = df["label"].value_counts().to_dict()
        result.update({
            "label_counts": label_counts,
            "label_ratio": {k: v/len(df) for k, v in label_counts.items()},
            "is_balanced": abs(label_counts.get(0, 0) - label_counts.get(1, 0)) < len(df) * 0.1,
        })

    if "generator" in df.columns:
        result["generator_counts"] = df["generator"].value_counts().to_dict()

    if "split" in df.columns:
        result["split_counts"] = df["split"].value_counts().to_dict()

    return result


def main():
    parser = argparse.ArgumentParser(description="Check class balance")
    parser.add_argument("manifests", nargs="+", help="Manifest file paths")
    parser.add_argument("--output", type=str, default="reports/class_balance.csv")
    args = parser.parse_args()

    results = []
    for manifest in args.manifests:
        result = check_class_balance(manifest)
        results.append(result)

        print(f"\n=== {Path(manifest).name} ===")
        print(f"Total: {result['total']}")
        if "label_counts" in result:
            print(f"Labels: {result['label_counts']}")
            print(f"Ratio: {result['label_ratio']}")
            print(f"Balanced: {result['is_balanced']}")
        if "generator_counts" in result:
            print(f"Generators: {result['generator_counts']}")

    # Save
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(results).to_csv(args.output, index=False)
    print(f"\nReport saved to {args.output}")


if __name__ == "__main__":
    main()
