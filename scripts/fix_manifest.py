"""Fix manifest: add source_id column and ensure proper splitting."""

import argparse
import pandas as pd
from pathlib import Path
from sklearn.model_selection import GroupShuffleSplit


def extract_source_id(image_path: str) -> str:
    """Extract source ID from image path.

    For Tiny-GenImage, the source_id is the numeric prefix before the image type.
    e.g., /path/to/real/real_000042.jpg -> 000042
    e.g., /path/to/fake/fake_000042.jpg -> 000042
    """
    stem = Path(image_path).stem
    # Remove prefix like "real_" or "fake_"
    parts = stem.split("_")
    if len(parts) > 1:
        return parts[-1]  # Return the numeric part
    return stem


def fix_manifest(input_path: str, output_path: str):
    """Add source_id column to manifest."""
    df = pd.read_csv(input_path)

    # Add source_id
    df["source_id"] = df["image_path"].apply(extract_source_id)

    # Verify
    print(f"Original manifest: {len(df)} rows")
    print(f"Unique source_ids: {df['source_id'].nunique()}")
    print(f"Label distribution: {df['label'].value_counts().to_dict()}")

    # Check for duplicate source_ids across labels
    source_label_counts = df.groupby("source_id")["label"].nunique()
    multi_label_sources = source_label_counts[source_label_counts > 1]
    print(f"Source IDs with multiple labels: {len(multi_label_sources)}")

    # Save
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    print(f"Fixed manifest saved to {output_path}")

    return df


def split_manifest_by_source_id(
    manifest_path: str,
    output_dir: str,
    train_ratio: float = 0.7,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    seed: int = 42,
):
    """Split manifest by source_id to prevent leakage."""
    df = pd.read_csv(manifest_path)

    if "source_id" not in df.columns:
        df["source_id"] = df["image_path"].apply(extract_source_id)

    # Group by source_id
    source_ids = df["source_id"].unique()
    print(f"Total source IDs: {len(source_ids)}")

    # Split source_ids
    n_train = int(len(source_ids) * train_ratio)
    n_val = int(len(source_ids) * val_ratio)

    # Shuffle source_ids
    import numpy as np
    np.random.seed(seed)
    shuffled_ids = np.random.permutation(source_ids)

    train_ids = set(shuffled_ids[:n_train])
    val_ids = set(shuffled_ids[n_train:n_train + n_val])
    test_ids = set(shuffled_ids[n_train + n_val:])

    # Split data
    df_train = df[df["source_id"].isin(train_ids)].copy()
    df_val = df[df["source_id"].isin(val_ids)].copy()
    df_test = df[df["source_id"].isin(test_ids)].copy()

    # Add split column
    df_train["split"] = "train"
    df_val["split"] = "val"
    df_test["split"] = "test"

    # Verify no leakage
    train_sources = set(df_train["source_id"])
    val_sources = set(df_val["source_id"])
    test_sources = set(df_test["source_id"])

    print(f"\nSplit results:")
    print(f"  Train: {len(df_train)} images, {len(train_sources)} sources")
    print(f"  Val: {len(df_val)} images, {len(val_sources)} sources")
    print(f"  Test: {len(df_test)} images, {len(test_sources)} sources")

    print(f"\nLeakage check:")
    print(f"  Train/Val overlap: {len(train_sources & val_sources)} sources")
    print(f"  Train/Test overlap: {len(train_sources & test_sources)} sources")
    print(f"  Val/Test overlap: {len(val_sources & test_sources)} sources")

    # Save
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    df_train.to_csv(output_dir / "train.csv", index=False)
    df_val.to_csv(output_dir / "val.csv", index=False)
    df_test.to_csv(output_dir / "test.csv", index=False)

    # Save combined
    df_all = pd.concat([df_train, df_val, df_test], ignore_index=True)
    df_all.to_csv(output_dir / "all.csv", index=False)

    print(f"\nSaved to {output_dir}/")
    print(f"  train.csv: {len(df_train)} rows")
    print(f"  val.csv: {len(df_val)} rows")
    print(f"  test.csv: {len(df_test)} rows")
    print(f"  all.csv: {len(df_all)} rows")

    return df_train, df_val, df_test


def main():
    parser = argparse.ArgumentParser(description="Fix manifest and split by source_id")
    parser.add_argument("--input", type=str, required=True, help="Input manifest CSV")
    parser.add_argument("--output-dir", type=str, required=True, help="Output directory")
    parser.add_argument("--train-ratio", type=float, default=0.7, help="Train ratio")
    parser.add_argument("--val-ratio", type=float, default=0.15, help="Val ratio")
    parser.add_argument("--test-ratio", type=float, default=0.15, help="Test ratio")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    # First fix manifest
    fixed_path = Path(args.output_dir) / "manifest_with_source_id.csv"
    fix_manifest(args.input, str(fixed_path))

    # Then split
    split_manifest_by_source_id(
        str(fixed_path),
        args.output_dir,
        args.train_ratio,
        args.val_ratio,
        args.test_ratio,
        args.seed,
    )


if __name__ == "__main__":
    main()
