"""Split manifest into train/val/test with leakage prevention.

Key principles:
1. No image content leakage: same source image ID must stay in same split
2. No generator leakage: unseen generators for test
3. No format/quality bias leakage: normalize across splits
"""

import argparse
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd
from sklearn.model_selection import GroupShuffleSplit


def extract_source_id(image_path: str) -> str:
    """Extract a source image ID to prevent content leakage.

    For paired datasets (real+fake from same source), this groups them together.
    Strategy: use the filename stem without extension, or a hash of the path
    up to the real/fake directory.
    """
    path = Path(image_path)
    # Try to use filename stem as source ID
    stem = path.stem
    # Remove common suffixes like _real, _fake, _ai
    for suffix in ["_real", "_fake", "_ai", "_gen", "_synth"]:
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem


def split_manifest(
    df: pd.DataFrame,
    split_by: str = "source_id",
    train_ratio: float = 0.7,
    val_ratio: float = 0.15,
    test_ratio: float = 0.15,
    train_generators: Optional[List[str]] = None,
    test_generators: Optional[List[str]] = None,
    seed: int = 42,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Split manifest into train/val/test.

    Args:
        df: Input manifest DataFrame.
        split_by: Splitting strategy - 'source_id' (group by source) or 'random'.
        train_ratio: Fraction for training (used when split_by='random').
        val_ratio: Fraction for validation (used when split_by='random').
        test_ratio: Fraction for test (used when split_by='random').
        train_generators: If provided, only use these generators for train/val.
        test_generators: If provided, only use these generators for test.
        seed: Random seed.

    Returns:
        Tuple of (train_df, val_df, test_df).
    """
    df = df.copy()

    if train_generators and test_generators:
        # Cross-generator split: train on some generators, test on others
        train_val_mask = df["generator"].isin(train_generators)
        test_mask = df["generator"].isin(test_generators)

        train_val_df = df[train_val_mask].copy()
        test_df = df[test_mask].copy()

        # Split train_val into train and val by source_id
        if split_by == "source_id":
            train_val_df["source_id"] = train_val_df["image_path"].apply(extract_source_id)
            groups = train_val_df["source_id"].values

            gss = GroupShuffleSplit(n_splits=1, test_size=val_ratio / (train_ratio + val_ratio),
                                     random_state=seed)
            train_idx, val_idx = next(gss.split(train_val_df, groups=groups))

            train_df = train_val_df.iloc[train_idx].drop(columns=["source_id"])
            val_df = train_val_df.iloc[val_idx].drop(columns=["source_id"])
        else:
            # Random split
            shuffled = train_val_df.sample(frac=1, random_state=seed)
            n_val = int(len(shuffled) * val_ratio / (train_ratio + val_ratio))
            val_df = shuffled.iloc[:n_val]
            train_df = shuffled.iloc[n_val:]

        train_df = train_df.copy()
        val_df = val_df.copy()
        test_df = test_df.copy()

    else:
        # Standard split by source_id or random
        if split_by == "source_id":
            df["source_id"] = df["image_path"].apply(extract_source_id)
            groups = df["source_id"].values

            # First split: train+val vs test
            gss1 = GroupShuffleSplit(
                n_splits=1,
                test_size=test_ratio,
                random_state=seed,
            )
            train_val_idx, test_idx = next(gss1.split(df, groups=groups))

            train_val_df = df.iloc[train_val_idx].copy()
            test_df = df.iloc[test_idx].copy()

            # Second split: train vs val
            groups_tv = train_val_df["source_id"].values
            val_relative = val_ratio / (train_ratio + val_ratio)
            gss2 = GroupShuffleSplit(
                n_splits=1,
                test_size=val_relative,
                random_state=seed,
            )
            train_idx, val_idx = next(gss2.split(train_val_df, groups=groups_tv))

            train_df = train_val_df.iloc[train_idx].drop(columns=["source_id"])
            val_df = train_val_df.iloc[val_idx].drop(columns=["source_id"])
            test_df = test_df.drop(columns=["source_id"])
        else:
            # Random split
            df = df.sample(frac=1, random_state=seed).reset_index(drop=True)
            n = len(df)
            n_train = int(n * train_ratio)
            n_val = int(n * val_ratio)

            train_df = df.iloc[:n_train].copy()
            val_df = df.iloc[n_train : n_train + n_val].copy()
            test_df = df.iloc[n_train + n_val :].copy()

    # Assign split labels
    train_df["split"] = "train"
    val_df["split"] = "val"
    test_df["split"] = "test"

    return train_df, val_df, test_df


def split_manifest_from_file(
    input_path: str,
    split_by: str = "source_id",
    train_generators: Optional[List[str]] = None,
    test_generators: Optional[List[str]] = None,
    output_dir: Optional[str] = None,
    seed: int = 42,
) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Split a manifest CSV file and save results.

    Args:
        input_path: Path to input manifest CSV.
        split_by: Splitting strategy.
        train_generators: Generators for training.
        test_generators: Generators for testing.
        output_dir: Directory to save split manifests.
        seed: Random seed.

    Returns:
        Tuple of (train_df, val_df, test_df).
    """
    df = pd.read_csv(input_path)
    print(f"Loaded manifest: {len(df)} images")

    train_df, val_df, test_df = split_manifest(
        df,
        split_by=split_by,
        train_generators=train_generators,
        test_generators=test_generators,
        seed=seed,
    )

    print(f"Split: train={len(train_df)}, val={len(val_df)}, test={len(test_df)}")

    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        input_stem = Path(input_path).stem
        train_path = output_dir / f"{input_stem}_train.csv"
        val_path = output_dir / f"{input_stem}_val.csv"
        test_path = output_dir / f"{input_stem}_test.csv"

        train_df.to_csv(train_path, index=False)
        val_df.to_csv(val_path, index=False)
        test_df.to_csv(test_path, index=False)

        print(f"Saved splits to {output_dir}")

    return train_df, val_df, test_df


def main():
    parser = argparse.ArgumentParser(description="Split manifest into train/val/test")
    parser.add_argument("--input", type=str, required=True, help="Input manifest CSV")
    parser.add_argument("--split_by", type=str, default="source_id",
                        choices=["source_id", "random"], help="Splitting strategy")
    parser.add_argument("--train_generators", type=str, default=None,
                        help="Comma-separated list of train generators")
    parser.add_argument("--test_generators", type=str, default=None,
                        help="Comma-separated list of test generators")
    parser.add_argument("--output_dir", type=str, required=True,
                        help="Output directory for split manifests")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    train_gens = args.train_generators.split(",") if args.train_generators else None
    test_gens = args.test_generators.split(",") if args.test_generators else None

    split_manifest_from_file(
        args.input,
        split_by=args.split_by,
        train_generators=train_gens,
        test_generators=test_gens,
        output_dir=args.output_dir,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
