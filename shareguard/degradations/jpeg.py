"""JPEG and WebP compression degradation."""

import io
from typing import Optional

import numpy as np
from PIL import Image


class JPEG:
    """JPEG compression degradation.

    Args:
        quality: JPEG quality (1-100). Lower = more compression.
        seed: Random seed for reproducibility.
    """

    def __init__(self, quality: int = 75, seed: Optional[int] = None):
        assert 1 <= quality <= 100, f"Quality must be 1-100, got {quality}"
        self.quality = quality
        self.seed = seed

    def __call__(self, image: Image.Image) -> Image.Image:
        """Apply JPEG compression.

        Args:
            image: Input PIL Image.

        Returns:
            JPEG-compressed PIL Image.
        """
        # Save to buffer with JPEG compression
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=self.quality)
        buffer.seek(0)

        # Load back
        compressed = Image.open(buffer).convert("RGB")
        return compressed

    def __repr__(self) -> str:
        return f"JPEG(quality={self.quality})"


class WEBP:
    """WebP compression degradation.

    Args:
        quality: WebP quality (1-100). Lower = more compression.
        method: Compression method (0-6). Higher = slower but better compression.
    """

    def __init__(self, quality: int = 75, method: int = 4):
        assert 1 <= quality <= 100, f"Quality must be 1-100, got {quality}"
        self.quality = quality
        self.method = method

    def __call__(self, image: Image.Image) -> Image.Image:
        """Apply WebP compression."""
        buffer = io.BytesIO()
        image.save(buffer, format="WEBP", quality=self.quality, method=self.method)
        buffer.seek(0)

        compressed = Image.open(buffer).convert("RGB")
        return compressed

    def __repr__(self) -> str:
        return f"WEBP(quality={self.quality})"


class RandomJPEG:
    """Random JPEG compression with quality sampled from a list.

    Args:
        qualities: List of possible quality values.
        seed: Random seed.
    """

    def __init__(self, qualities: list = None, seed: Optional[int] = None):
        self.qualities = qualities or [45, 60, 75, 90]
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def __call__(self, image: Image.Image) -> Image.Image:
        quality = int(self._rng.choice(self.qualities))
        return JPEG(quality=quality)(image)

    def __repr__(self) -> str:
        return f"RandomJPEG(qualities={self.qualities})"
