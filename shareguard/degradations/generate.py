"""Generate degraded images for testing.

Supports chunked processing for SLURM array jobs.
"""

import argparse
from pathlib import Path
from typing import Dict, Optional

import pandas as pd
from PIL import Image
from tqdm import tqdm

from .registry import DegradationRegistry
from ..utils.io import load_config


def generate_degradations(
    manifest_path: str,
    config_path: str,
    output_root: str,
    chunk_id: Optional[int] = None,
    num_chunks: Optional[int] = None,
    overwrite: bool = False,
) -> str:
    """Generate degraded images from a manifest.

    Args:
        manifest_path: Path to input manifest CSV.
        config_path: Path to degradation config YAML.
        output_root: Root directory for degraded images.
        chunk_id: Chunk ID for array jobs.
        num_chunks: Total number of chunks.
        overwrite: Whether to overwrite existing files.

    Returns:
        Path to output manifest.
    """
    # Load manifest
    df = pd.read_csv(manifest_path)

    # Handle chunking
    if chunk_id is not None and num_chunks is not None:
        chunk_size = len(df) // num_chunks
        remainder = len(df) % num_chunks
        start = chunk_id * chunk_size + min(chunk_id, remainder)
        end = start + chunk_size + (1 if chunk_id < remainder else 0)
        df = df.iloc[start:end]

    # Load config
    config = load_config(config_path)
    degradation_names = [d["name"] for d in config.get("degradations", [])]

    # Setup registry
    registry = DegradationRegistry()
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    # Process each degradation
    for deg_name in degradation_names:
        print(f"Generating degradation: {deg_name}")
        degradation = registry.get(deg_name)

        deg_dir = output_root / deg_name
        deg_dir.mkdir(parents=True, exist_ok=True)

        new_paths = []
        for _, row in tqdm(df.iterrows(), total=len(df), desc=deg_name):
            img_path = Path(row["image_path"])
            out_path = deg_dir / img_path.name

            if out_path.exists() and not overwrite:
                new_paths.append(str(out_path))
                continue

            try:
                img = Image.open(img_path).convert("RGB")
                degraded = degradation(img)
                degraded.save(out_path, format="JPEG", quality=95)
                new_paths.append(str(out_path))
            except Exception as e:
                print(f"Warning: Failed to process {img_path}: {e}")
                new_paths.append(str(img_path))

        # Save manifest for this degradation
        deg_df = df.copy()
        deg_df["image_path"] = new_paths
        deg_df["quality_group"] = deg_name

        if chunk_id is not None:
            manifest_out = output_root / f"manifest_{deg_name}_chunk_{chunk_id:04d}.csv"
        else:
            manifest_out = output_root / f"manifest_{deg_name}.csv"

        deg_df.to_csv(manifest_out, index=False)
        print(f"Saved manifest: {manifest_out}")

    return str(output_root)


def main():
    parser = argparse.ArgumentParser(description="Generate degraded images")
    parser.add_argument("--manifest", type=str, required=True, help="Input manifest CSV")
    parser.add_argument("--config", type=str, required=True, help="Degradation config YAML")
    parser.add_argument("--output-root", type=str, required=True, help="Output directory")
    parser.add_argument("--chunk-id", type=int, default=None, help="Chunk ID")
    parser.add_argument("--num-chunks", type=int, default=None, help="Number of chunks")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing files")
    args = parser.parse_args()

    generate_degradations(
        args.manifest,
        args.config,
        args.output_root,
        args.chunk_id,
        args.num_chunks,
        args.overwrite,
    )


if __name__ == "__main__":
    main()
