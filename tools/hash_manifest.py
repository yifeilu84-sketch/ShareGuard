"""Hash manifest files for reproducibility tracking."""

import argparse
import hashlib
import json
from pathlib import Path


def hash_file(filepath: str) -> str:
    """Compute SHA256 hash of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def hash_manifest(manifest_path: str) -> dict:
    """Hash a manifest CSV and return metadata."""
    path = Path(manifest_path)
    if not path.exists():
        return {"path": str(path), "exists": False}

    import pandas as pd
    df = pd.read_csv(path)

    return {
        "path": str(path),
        "exists": True,
        "sha256": hash_file(manifest_path),
        "num_rows": len(df),
        "columns": list(df.columns),
        "label_distribution": df["label"].value_counts().to_dict() if "label" in df.columns else {},
        "generator_distribution": df["generator"].value_counts().to_dict() if "generator" in df.columns else {},
    }


def main():
    parser = argparse.ArgumentParser(description="Hash manifest files")
    parser.add_argument("manifests", nargs="+", help="Manifest file paths")
    parser.add_argument("--output", type=str, default="reports/manifest_hashes.json")
    args = parser.parse_args()

    results = {}
    for manifest in args.manifests:
        results[Path(manifest).name] = hash_manifest(manifest)

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)

    print(f"Hashes saved to {args.output}")
    for name, info in results.items():
        if info.get("exists"):
            print(f"  {name}: {info['sha256'][:16]}... ({info['num_rows']} rows)")
        else:
            print(f"  {name}: NOT FOUND")


if __name__ == "__main__":
    main()
