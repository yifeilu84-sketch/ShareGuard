"""Expand test set to 5000+ images."""

import argparse
import pandas as pd
from pathlib import Path


def expand_test_set(
    manifest_path: str,
    output_path: str,
    target_size: int = 5000,
    seed: int = 42,
):
    """Expand test set by sampling more images from the dataset."""
    df = pd.read_csv(manifest_path)

    print(f"Original manifest: {len(df)} images")

    # If we have source_id, use it for proper sampling
    if "source_id" in df.columns:
        # Get unique source IDs
        source_ids = df["source_id"].unique()
        print(f"Unique source IDs: {len(source_ids)}")

        # Sample source IDs
        import numpy as np
        np.random.seed(seed)

        if len(source_ids) >= target_size // 2:
            # Enough source IDs, sample them
            sampled_ids = np.random.choice(source_ids, size=target_size // 2, replace=False)
            df_expanded = df[df["source_id"].isin(sampled_ids)]
        else:
            # Not enough source IDs, use all and sample within
            df_expanded = df
            if len(df_expanded) < target_size:
                # Oversample
                df_expanded = df_expanded.sample(n=target_size, replace=True, random_state=seed)
    else:
        # No source_id, just sample
        if len(df) >= target_size:
            df_expanded = df.sample(n=target_size, random_state=seed)
        else:
            df_expanded = df.sample(n=target_size, replace=True, random_state=seed)

    print(f"Expanded test set: {len(df_expanded)} images")

    if "label" in df_expanded.columns:
        print(f"Label distribution: {df_expanded['label'].value_counts().to_dict()}")

    # Save
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    df_expanded.to_csv(output_path, index=False)
    print(f"Saved to {output_path}")

    return df_expanded


def main():
    parser = argparse.ArgumentParser(description="Expand test set")
    parser.add_argument("--input", type=str, required=True, help="Input manifest")
    parser.add_argument("--output", type=str, required=True, help="Output manifest")
    parser.add_argument("--target-size", type=int, default=5000, help="Target test set size")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    expand_test_set(args.input, args.output, args.target_size, args.seed)


if __name__ == "__main__":
    main()
