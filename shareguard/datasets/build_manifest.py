"""Build manifest CSV files from raw datasets.

Supports GenImage, Synthbuster, and TrueFake datasets.
"""

import argparse
import re
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
from PIL import Image
from tqdm import tqdm

# Dataset-specific configurations
DATASET_CONFIGS = {
    "genimage": {
        "generators": [
            "stable_diffusion_v1", "stable_diffusion_v1_5",
            "adm", "glide", "midjourney", "dalle", "stable_diffusion_xl",
            "vq_diffusion", "wukong", "imagenet",
        ],
        "label_from_dir": True,  # real/fake subdirectory
    },
    "synthbuster": {
        "generators": [
            "dalle2", "dalle3", "firefly", "ideogram",
            "midjourney", "stable_diffusion", "stable_diffusion_xl",
        ],
        "label_from_filename": True,
    },
    "truefake": {
        "generators": ["real", "ai"],
        "label_from_dir": True,
    },
}


def get_image_info(path: Path) -> Dict:
    """Extract image metadata."""
    try:
        with Image.open(path) as img:
            width, height = img.size
            fmt = img.format.lower() if img.format else path.suffix.lstrip(".")
        return {"width": width, "height": height, "original_format": fmt}
    except Exception:
        return {"width": -1, "height": -1, "original_format": "unknown"}


def detect_generator(path: Path, dataset: str) -> str:
    """Detect generator name from file path."""
    path_str = str(path).lower()

    if dataset == "genimage":
        # GenImage structure: root/generator/real_or_fake/image.jpg
        for gen in DATASET_CONFIGS["genimage"]["generators"]:
            if gen in path_str:
                return gen
        return "unknown"

    elif dataset == "synthbuster":
        for gen in DATASET_CONFIGS["synthbuster"]["generators"]:
            if gen in path_str:
                return gen
        return "unknown"

    elif dataset == "truefake":
        if "/real/" in path_str or "\\real\\" in path_str:
            return "real"
        return "ai"

    return "unknown"


def detect_label(path: Path, dataset: str) -> int:
    """Detect label (0=real, 1=fake) from path."""
    path_str = str(path).lower()

    if dataset in ("genimage", "truefake"):
        # Label from directory: real=0, fake/gan/diffusion=1
        if "/real/" in path_str or "\\real\\" in path_str:
            return 0
        return 1

    elif dataset == "synthbuster":
        # Synthbuster: real images in 'raise1k' or similar, fake in generator dirs
        if "raise1k" in path_str or "real" in path_str.split("/")[-2]:
            return 0
        return 1

    return -1


def build_genimage_manifest(root: Path) -> pd.DataFrame:
    """Build manifest for GenImage dataset.

    Expected structure:
        root/
            generator_name/
                real/
                    image.jpg
                fake/ (or ai/)
                    image.jpg
    """
    records = []
    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

    print(f"Scanning GenImage at {root}...")
    for img_path in tqdm(list(root.rglob("*"))):
        if img_path.suffix.lower() not in image_extensions:
            continue
        if not img_path.is_file():
            continue

        info = get_image_info(img_path)
        generator = detect_generator(img_path, "genimage")
        label = detect_label(img_path, "genimage")

        # Detect real_source from parent directory name
        parts = img_path.parts
        real_source = "unknown"
        for part in parts:
            part_lower = part.lower()
            if "imagenet" in part_lower:
                real_source = "imagenet"
                break
            elif "places" in part_lower:
                real_source = "places"
                break

        records.append({
            "image_path": str(img_path),
            "label": label,
            "source_dataset": "GenImage",
            "generator": generator,
            "real_source": real_source,
            "split": "unassigned",
            "width": info["width"],
            "height": info["height"],
            "original_format": info["original_format"],
            "quality_group": "clean",
            "share_type": "none",
        })

    return pd.DataFrame(records)


def build_synthbuster_manifest(root: Path) -> pd.DataFrame:
    """Build manifest for Synthbuster dataset.

    Expected structure:
        root/
            generator_name/
                image.png
            raise1k/ (real images)
                image.png
    """
    records = []
    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

    print(f"Scanning Synthbuster at {root}...")
    for img_path in tqdm(list(root.rglob("*"))):
        if img_path.suffix.lower() not in image_extensions:
            continue
        if not img_path.is_file():
            continue

        info = get_image_info(img_path)
        generator = detect_generator(img_path, "synthbuster")
        label = detect_label(img_path, "synthbuster")

        records.append({
            "image_path": str(img_path),
            "label": label,
            "source_dataset": "Synthbuster",
            "generator": generator,
            "real_source": "raise1k" if label == 0 else "unknown",
            "split": "test",
            "width": info["width"],
            "height": info["height"],
            "original_format": info["original_format"],
            "quality_group": "clean",
            "share_type": "none",
        })

    return pd.DataFrame(records)


def build_truefake_manifest(root: Path) -> pd.DataFrame:
    """Build manifest for TrueFake dataset.

    Expected structure:
        root/
            real/
                image.jpg
            ai/
                image.jpg
            shared/ (optional)
                facebook/
                twitter/
                telegram/
    """
    records = []
    image_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

    print(f"Scanning TrueFake at {root}...")
    for img_path in tqdm(list(root.rglob("*"))):
        if img_path.suffix.lower() not in image_extensions:
            continue
        if not img_path.is_file():
            continue

        info = get_image_info(img_path)
        generator = detect_generator(img_path, "truefake")
        label = detect_label(img_path, "truefake")

        # Detect share type from path
        path_str = str(img_path).lower()
        share_type = "none"
        quality_group = "clean"
        if "facebook" in path_str:
            share_type = "facebook"
            quality_group = "platform"
        elif "twitter" in path_str or "/x/" in path_str:
            share_type = "x"
            quality_group = "platform"
        elif "telegram" in path_str:
            share_type = "telegram"
            quality_group = "platform"
        elif "shared" in path_str:
            share_type = "simulated"
            quality_group = "platform"

        records.append({
            "image_path": str(img_path),
            "label": label,
            "source_dataset": "TrueFake",
            "generator": generator,
            "real_source": "unknown",
            "split": "test",
            "width": info["width"],
            "height": info["height"],
            "original_format": info["original_format"],
            "quality_group": quality_group,
            "share_type": share_type,
        })

    return pd.DataFrame(records)


BUILDERS = {
    "genimage": build_genimage_manifest,
    "synthbuster": build_synthbuster_manifest,
    "truefake": build_truefake_manifest,
}


def build_manifest(dataset: str, root: Path, output: Optional[Path] = None) -> pd.DataFrame:
    """Build manifest for a dataset.

    Args:
        dataset: Dataset name (genimage, synthbuster, truefake).
        root: Root directory of the dataset.
        output: Optional path to save the manifest CSV.

    Returns:
        DataFrame with manifest records.
    """
    if dataset not in BUILDERS:
        raise ValueError(f"Unknown dataset: {dataset}. Supported: {list(BUILDERS.keys())}")

    df = BUILDERS[dataset](root)
    print(f"Built manifest: {len(df)} images, {df['label'].sum()} fake, "
          f"{(df['label'] == 0).sum()} real")

    if output:
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(output, index=False)
        print(f"Saved manifest to {output}")

    return df


def main():
    parser = argparse.ArgumentParser(description="Build dataset manifest")
    parser.add_argument("--dataset", type=str, required=True,
                        choices=list(BUILDERS.keys()),
                        help="Dataset name")
    parser.add_argument("--root", type=str, required=True,
                        help="Root directory of the dataset")
    parser.add_argument("--output", type=str, required=True,
                        help="Output CSV path")
    args = parser.parse_args()

    build_manifest(args.dataset, Path(args.root), Path(args.output))


if __name__ == "__main__":
    main()
