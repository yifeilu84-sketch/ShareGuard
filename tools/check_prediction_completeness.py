"""Check prediction completeness and format."""

import argparse
import pandas as pd
from pathlib import Path


REQUIRED_COLUMNS = [
    "image_id", "source_id", "label", "score", "prediction",
    "correct", "model", "seed", "dataset", "generator",
    "degradation", "severity",
]


def check_prediction_completeness(pred_path: str) -> dict:
    """Check if prediction CSV has all required columns and no missing values."""
    df = pd.read_csv(pred_path)

    result = {
        "path": pred_path,
        "num_rows": len(df),
        "columns": list(df.columns),
        "missing_columns": [c for c in REQUIRED_COLUMNS if c not in df.columns],
        "has_all_columns": all(c in df.columns for c in REQUIRED_COLUMNS),
    }

    # Check for missing values
    missing_counts = df.isnull().sum().to_dict()
    result["missing_values"] = {k: v for k, v in missing_counts.items() if v > 0}

    # Check prediction completeness
    if "score" in df.columns:
        result["score_range"] = [float(df["score"].min()), float(df["score"].max())]
        result["has_nan_scores"] = df["score"].isnull().any()

    if "prediction" in df.columns:
        result["prediction_values"] = df["prediction"].value_counts().to_dict()

    if "correct" in df.columns:
        result["accuracy"] = float(df["correct"].mean())

    return result


def main():
    parser = argparse.ArgumentParser(description="Check prediction completeness")
    parser.add_argument("predictions", nargs="+", help="Prediction CSV paths")
    parser.add_argument("--output", type=str, default="reports/prediction_check.csv")
    args = parser.parse_args()

    results = []
    for pred in args.predictions:
        result = check_prediction_completeness(pred)
        results.append(result)

        print(f"\n=== {Path(pred).name} ===")
        print(f"Rows: {result['num_rows']}")
        print(f"Has all columns: {result['has_all_columns']}")
        if result["missing_columns"]:
            print(f"Missing columns: {result['missing_columns']}")
        if result["missing_values"]:
            print(f"Missing values: {result['missing_values']}")
        if "accuracy" in result:
            print(f"Accuracy: {result['accuracy']:.4f}")

    # Save
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(results).to_csv(args.output, index=False)
    print(f"\nReport saved to {args.output}")


if __name__ == "__main__":
    main()
