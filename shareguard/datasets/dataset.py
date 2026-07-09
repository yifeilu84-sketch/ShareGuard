"""Dataset class for NoisyShareBench.

Supports loading from manifest CSV with optional online degradation.
"""

from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import torch
from PIL import Image
from torch.utils.data import Dataset
from torchvision import transforms


class NoisyShareDataset(Dataset):
    """Dataset for AI-generated image detection with optional degradation.

    Args:
        manifest_path: Path to manifest CSV file.
        manifest_df: Alternatively, provide a DataFrame directly.
        transform: Torchvision transform for image preprocessing.
        degradation: Optional degradation pipeline to apply.
        cache_features: If provided, load pre-cached features instead of images.
        return_metadata: If True, return metadata dict along with image and label.
    """

    def __init__(
        self,
        manifest_path: Optional[str] = None,
        manifest_df: Optional[pd.DataFrame] = None,
        transform: Optional[Callable] = None,
        degradation: Optional[Callable] = None,
        cache_features: Optional[str] = None,
        return_metadata: bool = False,
    ):
        if manifest_df is not None:
            self.df = manifest_df.reset_index(drop=True)
        elif manifest_path is not None:
            self.df = pd.read_csv(manifest_path)
        else:
            raise ValueError("Either manifest_path or manifest_df must be provided")

        self.transform = transform
        self.degradation = degradation
        self.return_metadata = return_metadata

        # Feature cache
        self.cache_features = cache_features
        self._features = None
        self._labels = None
        if cache_features:
            self._load_cached_features(cache_features)

    def _load_cached_features(self, path: str):
        """Load pre-cached features from disk."""
        data = torch.load(path, map_location="cpu")
        self._features = data["features"]  # [N, D]
        self._labels = data["labels"]  # [N]
        assert len(self._features) == len(self.df), (
            f"Feature count ({len(self._features)}) != manifest count ({len(self.df)})"
        )

    def __len__(self) -> int:
        return len(self.df)

    def __getitem__(self, idx: int) -> Tuple[Any, int, Optional[Dict]]:
        row = self.df.iloc[idx]
        label = int(row["label"])

        # Return cached features if available
        if self._features is not None:
            feat = self._features[idx]
            if self.return_metadata:
                metadata = row.to_dict()
                return feat, label, metadata
            return feat, label

        # Load image
        img_path = row["image_path"]
        try:
            image = Image.open(img_path).convert("RGB")
        except Exception as e:
            # Return a black image on error
            print(f"Warning: Failed to load {img_path}: {e}")
            image = Image.new("RGB", (512, 512), (0, 0, 0))

        # Apply degradation
        if self.degradation is not None:
            image = self.degradation(image)

        # Apply transform
        if self.transform is not None:
            image = self.transform(image)

        if self.return_metadata:
            metadata = row.to_dict()
            return image, label, metadata

        return image, label


class MultiViewDataset(Dataset):
    """Dataset that returns multiple degraded views for RIDE training.

    Args:
        manifest_path: Path to manifest CSV file.
        manifest_df: Alternatively, provide a DataFrame directly.
        transform: Base transform for all views.
        view_degradations: List of degradation pipelines, one per view.
        num_views: Number of views to generate.
    """

    def __init__(
        self,
        manifest_path: Optional[str] = None,
        manifest_df: Optional[pd.DataFrame] = None,
        transform: Optional[Callable] = None,
        view_degradations: Optional[List[Callable]] = None,
        num_views: int = 4,
    ):
        if manifest_df is not None:
            self.df = manifest_df.reset_index(drop=True)
        elif manifest_path is not None:
            self.df = pd.read_csv(manifest_path)
        else:
            raise ValueError("Either manifest_path or manifest_df must be provided")

        self.transform = transform
        self.view_degradations = view_degradations or []
        self.num_views = num_views

    def __len__(self) -> int:
        return len(self.df)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, int]:
        row = self.df.iloc[idx]
        label = int(row["label"])

        # Load image
        img_path = row["image_path"]
        try:
            image = Image.open(img_path).convert("RGB")
        except Exception:
            image = Image.new("RGB", (512, 512), (0, 0, 0))

        views = []
        for i in range(self.num_views):
            # Apply view-specific degradation
            if i < len(self.view_degradations) and self.view_degradations[i] is not None:
                view = self.view_degradations[i](image)
            else:
                view = image.copy()

            # Apply base transform
            if self.transform is not None:
                view = self.transform(view)

            views.append(view)

        # Stack views: [K, C, H, W]
        views_tensor = torch.stack(views, dim=0)

        return views_tensor, label


def get_default_transform(
    image_size: int = 512,
    backbone: str = "dinov2",
) -> transforms.Compose:
    """Get default image transform.

    Args:
        image_size: Target image size.
        backbone: Backbone type for size adjustment.

    Returns:
        Composed transform.
    """
    # Adjust size for specific backbones
    if backbone == "dinov2":
        # DINOv2 expects 518x518 but we can use 512 and let the backbone handle it
        size = image_size
    elif backbone == "clip":
        size = 224  # CLIP default
    else:
        size = image_size

    return transforms.Compose([
        transforms.Resize(size, interpolation=transforms.InterpolationMode.BICUBIC),
        transforms.CenterCrop(size),
        transforms.ToTensor(),
        transforms.Normalize(
            mean=[0.485, 0.456, 0.406],
            std=[0.229, 0.224, 0.225],
        ),
    ])


def get_train_transform(
    image_size: int = 512,
    augmentation: bool = True,
) -> transforms.Compose:
    """Get training transform with optional augmentation.

    Args:
        image_size: Target image size.
        augmentation: Whether to apply random augmentation.

    Returns:
        Composed transform.
    """
    if augmentation:
        return transforms.Compose([
            transforms.Resize(int(image_size * 1.1),
                              interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.RandomCrop(image_size),
            transforms.RandomHorizontalFlip(p=0.5),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ])
    else:
        return get_default_transform(image_size)
