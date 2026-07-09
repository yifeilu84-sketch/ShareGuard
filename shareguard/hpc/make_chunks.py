"""Split manifest into chunks for parallel processing."""

import argparse
from pathlib import Path

import pandas as pd


def split_manifest_into_chunks(
    manifest_path: str,
    num_chunks: int,
    output_dir: str,
    prefix: str = "chunk",
):
    """Split a manifest CSV into chunks for SLURM array jobs.

    Args:
        manifest_path: Path to input manifest CSV.
        num_chunks: Number of chunks to split into.
        output_dir: Output directory for chunk files.
        prefix: Filename prefix for chunks.
    """
    df = pd.read_csv(manifest_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    chunk_size = len(df) // num_chunks
    remainder = len(df) % num_chunks

    start = 0
    for i in range(num_chunks):
        end = start + chunk_size + (1 if i < remainder else 0)
        chunk_df = df.iloc[start:end]
        chunk_path = output_dir / f"{prefix}_{i:04d}.csv"
        chunk_df.to_csv(chunk_path, index=False)
        start = end

    # Save metadata
    meta = {
        "num_chunks": num_chunks,
        "total_rows": len(df),
        "manifest_path": str(manifest_path),
    }
    import json
    with open(output_dir / "chunks_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Split {len(df)} rows into {num_chunks} chunks in {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Split manifest into chunks")
    parser.add_argument("--manifest", type=str, required=True, help="Input manifest CSV")
    parser.add_argument("--num-chunks", type=int, required=True, help="Number of chunks")
    parser.add_argument("--output-dir", type=str, required=True, help="Output directory")
    parser.add_argument("--prefix", type=str, default="chunk", help="Filename prefix")
    args = parser.parse_args()

    split_manifest_into_chunks(args.manifest, args.num_chunks, args.output_dir, args.prefix)


if __name__ == "__main__":
    main()
