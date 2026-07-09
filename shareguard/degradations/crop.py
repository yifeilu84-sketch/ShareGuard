"""Crop degradation."""

from typing import List, Optional

import numpy as np
from PIL import Image


class CenterCrop:
    """Center crop and resize back to original size.

    Args:
        ratio: Crop ratio (e.g., 0.9 keeps 90% of the image).
    """

    def __init__(self, ratio: float = 0.9):
        assert 0 < ratio <= 1.0, f"Ratio must be in (0, 1], got {ratio}"
        self.ratio = ratio

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        new_w = int(w * self.ratio)
        new_h = int(h * self.ratio)

        left = (w - new_w) // 2
        top = (h - new_h) // 2
        right = left + new_w
        bottom = top + new_h

        cropped = image.crop((left, top, right, bottom))
        # Resize back to original size
        return cropped.resize((w, h), Image.BICUBIC)

    def __repr__(self) -> str:
        return f"CenterCrop(ratio={self.ratio})"


class RandomCrop:
    """Random crop and resize back to original size.

    Args:
        ratio: Crop ratio or list of possible ratios.
        seed: Random seed.
    """

    def __init__(self, ratio: float = 0.9, seed: Optional[int] = None):
        if isinstance(ratio, list):
            self.ratios = ratio
        else:
            self.ratios = [ratio]
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def __call__(self, image: Image.Image) -> Image.Image:
        ratio = float(self._rng.choice(self.ratios))
        w, h = image.size
        new_w = int(w * ratio)
        new_h = int(h * ratio)

        left = self._rng.randint(0, max(1, w - new_w))
        top = self._rng.randint(0, max(1, h - new_h))
        right = left + new_w
        bottom = top + new_h

        cropped = image.crop((left, top, right, bottom))
        return cropped.resize((w, h), Image.BICUBIC)

    def __repr__(self) -> str:
        return f"RandomCrop(ratios={self.ratios})"


class CornerCrop:
    """Crop from a corner and resize back.

    Args:
        ratio: Crop ratio.
        corner: Which corner ('top_left', 'top_right', 'bottom_left', 'bottom_right').
    """

    def __init__(self, ratio: float = 0.9, corner: str = "top_left"):
        self.ratio = ratio
        self.corner = corner

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        new_w = int(w * self.ratio)
        new_h = int(h * self.ratio)

        if self.corner == "top_left":
            left, top = 0, 0
        elif self.corner == "top_right":
            left, top = w - new_w, 0
        elif self.corner == "bottom_left":
            left, top = 0, h - new_h
        elif self.corner == "bottom_right":
            left, top = w - new_w, h - new_h
        else:
            raise ValueError(f"Unknown corner: {self.corner}")

        right = left + new_w
        bottom = top + new_h

        cropped = image.crop((left, top, right, bottom))
        return cropped.resize((w, h), Image.BICUBIC)

    def __repr__(self) -> str:
        return f"CornerCrop(ratio={self.ratio}, corner={self.corner})"
