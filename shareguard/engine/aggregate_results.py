"""Aggregate evaluation results from multiple jobs."""

import argparse
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
import yaml


def aggregate_results(
    input_dir: str,
    output_csv: str = None,
    metrics: List[str] = None,
) -> pd.DataFrame:
    """Aggregate results from multiple evaluation runs.

    Args:
        input_dir: Directory containing result files.
        output_csv: Path to save aggregated CSV.
        metrics: Metrics to include.

    Returns:
        Aggregated DataFrame.
    """
    input_dir = Path(input_dir)

    if metrics is None:
        metrics = ["auc", "ap", "f1", "accuracy", "ece"]

    all_results = []

    # Find all result files
    for result_file in input_dir.rglob("*.yaml"):
        try:
            with open(result_file, "r") as f:
                result = yaml.safe_load(f)
            if result:
                result["source_file"] = str(result_file)
                all_results.append(result)
        except Exception as e:
            print(f"Warning: Failed to load {result_file}: {e}")

    # Also check CSV files
    for result_file in input_dir.rglob("*.csv"):
        try:
            df = pd.read_csv(result_file)
            for _, row in df.iterrows():
                all_results.append(row.to_dict())
        except Exception as e:
            print(f"Warning: Failed to load {result_file}: {e}")

    if not all_results:
        print(f"No results found in {input_dir}")
        return pd.DataFrame()

    df = pd.DataFrame(all_results)

    if output_csv:
        Path(output_csv).parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(output_csv, index=False)
        print(f"Saved aggregated results to {output_csv}")

    return df


def merge_multi_seed_results(
    results: List[Dict],
    group_by: List[str] = None,
    metrics: List[str] = None,
) -> pd.DataFrame:
    """Merge results from multiple seeds and compute statistics.

    Args:
        results: List of result dicts.
        group_by: Columns to group by (e.g., method, degradation).
        metrics: Metric columns to aggregate.

    Returns:
        DataFrame with mean and std.
    """
    if group_by is None:
        group_by = ["method", "degradation"]

    if metrics is None:
        metrics = ["auc", "ap", "f1", "ece"]

    df = pd.DataFrame(results)

    # Group and aggregate
    grouped = df.groupby(group_by)[metrics].agg(["mean", "std"]).reset_index()

    # Flatten column names
    grouped.columns = [f"{col[0]}_{col[1]}" if col[1] else col[0]
                       for col in grouped.columns]

    return grouped


def main():
    parser = argparse.ArgumentParser(description="Aggregate evaluation results")
    parser.add_argument("--input-dir", type=str, required=True, help="Input directory")
    parser.add_argument("--output-csv", type=str, default=None, help="Output CSV path")
    args = parser.parse_args()

    df = aggregate_results(args.input_dir, args.output_csv)
    print(f"Aggregated {len(df)} results")
    print(df.head())


if __name__ == "__main__":
    main()
