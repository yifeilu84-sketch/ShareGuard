"""Extract features from images using frozen encoders.

Supports chunked processing for SLURM array jobs.
"""

import argparse
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
import torch
from PIL import Image
from torchvision import transforms
from tqdm import tqdm

from ..models.encoders import get_encoder
from ..degradations.registry import DegradationRegistry
from ..utils.seed import set_seed


def get_transform(encoder_name: str, image_size: int = 512) -> transforms.Compose:
    """Get image transform for encoder."""
    if "clip" in encoder_name.lower():
        size = 224
    elif "siglip" in encoder_name.lower():
        size = 224
    else:
        size = image_size

    return transforms.Compose([
        transforms.Resize(size, interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.CenterCrop(size),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])


def extract_features_chunk(
    manifest_path: str,
    encoder_name: str,
    view_names: List[str] = None,
    precision: str = "fp32",
    image_size: int = 512,
    device: torch.device = None,
) -> dict:
    """Extract features for a chunk of images.

    Args:
        manifest_path: Path to manifest CSV.
        encoder_name: Encoder model name.
        view_names: List of degradation view names. None = ['identity'].
        precision: 'fp32' or 'fp16'.
        image_size: Target image size.
        device: Torch device.

    Returns:
        Dict with 'features', 'labels', 'paths'.
    """
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if view_names is None:
        view_names = ["identity"]

    # Load encoder
    encoder = get_encoder(encoder_name, mode="frozen")
    encoder = encoder.to(device)
    encoder.eval()

    # Load degradations
    registry = DegradationRegistry()
    degradations = []
    for name in view_names:
        if name == "identity":
            degradations.append(None)
        else:
            degradations.append(registry.get(name))

    # Transform
    transform = get_transform(encoder_name, image_size)

    # Load manifest
    df = pd.read_csv(manifest_path)

    all_features = []
    all_labels = []
    all_paths = []
    dtype = torch.float16 if precision == "fp16" else torch.float32

    for _, row in tqdm(df.iterrows(), total=len(df), desc="Extracting features"):
        try:
            img = Image.open(row["image_path"]).convert("RGB")

            # Extract features for each view
            view_features = []
            for deg in degradations:
                if deg is not None:
                    view = deg(img)
                else:
                    view = img.copy()

                tensor = transform(view).unsqueeze(0).to(device).to(dtype)

                with torch.no_grad():
                    feat = encoder(tensor).cpu()

                view_features.append(feat)

            # Stack views: [K, D]
            features = torch.cat(view_features, dim=0)
            all_features.append(features)
            all_labels.append(row["label"])
            all_paths.append(row["image_path"])

        except Exception as e:
            print(f"Error processing {row['image_path']}: {e}")
            continue

    # Stack: [N, K, D] for multi-view, [N, 1, D] for single view
    all_features = torch.stack(all_features, dim=0)
    all_labels = torch.tensor(all_labels)

    return {
        "features": all_features,
        "labels": all_labels,
        "paths": all_paths,
        "encoder": encoder_name,
        "views": view_names,
    }


def main():
    parser = argparse.ArgumentParser(description="Extract features from images")
    parser.add_argument("--manifest", type=str, required=True, help="Manifest CSV path")
    parser.add_argument("--chunk-id", type=int, default=None, help="Chunk ID for array jobs")
    parser.add_argument("--num-chunks", type=int, default=None, help="Total number of chunks")
    parser.add_argument("--encoder", type=str, default="dinov2_vitb14", help="Encoder name")
    parser.add_argument("--views", type=str, default="identity", help="Comma-separated view names")
    parser.add_argument("--precision", type=str, default="fp32", choices=["fp32", "fp16"])
    parser.add_argument("--image-size", type=int, default=512, help="Image size")
    parser.add_argument("--output-dir", type=str, required=True, help="Output directory")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    set_seed(args.seed)

    # Handle chunking
    manifest_path = args.manifest
    if args.chunk_id is not None and args.num_chunks is not None:
        df = pd.read_csv(args.manifest)
        chunk_size = len(df) // args.num_chunks
        remainder = len(df) % args.num_chunks

        start = args.chunk_id * chunk_size + min(args.chunk_id, remainder)
        end = start + chunk_size + (1 if args.chunk_id < remainder else 0)

        chunk_df = df.iloc[start:end]
        chunk_manifest = Path(args.output_dir) / f"chunk_{args.chunk_id:04d}.csv"
        chunk_manifest.parent.mkdir(parents=True, exist_ok=True)
        chunk_df.to_csv(chunk_manifest, index=False)
        manifest_path = str(chunk_manifest)

    # Parse views
    view_names = [v.strip() for v in args.views.split(",")]

    # Extract features
    result = extract_features_chunk(
        manifest_path=manifest_path,
        encoder_name=args.encoder,
        view_names=view_names,
        precision=args.precision,
        image_size=args.image_size,
    )

    # Save
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.chunk_id is not None:
        output_path = output_dir / f"features_{args.chunk_id:04d}.pt"
    else:
        output_path = output_dir / "features.pt"

    torch.save(result, output_path)
    print(f"Saved features to {output_path}")
    print(f"  Shape: {result['features'].shape}")
    print(f"  Labels: {result['labels'].shape}")


if __name__ == "__main__":
    main()
