"""Resize degradation."""

from typing import List, Optional, Tuple, Union

import numpy as np
from PIL import Image


class Resize:
    """Resize image by scale factor or to a target short side.

    Args:
        scale: Scale factor (e.g., 0.75 for 75% of original size).
        short_side: Target short side length. Overrides scale if provided.
        interpolation: PIL interpolation method.
    """

    def __init__(
        self,
        scale: Optional[float] = None,
        short_side: Optional[int] = None,
        interpolation: int = Image.BICUBIC,
    ):
        assert scale is not None or short_side is not None, \
            "Either scale or short_side must be provided"
        self.scale = scale
        self.short_side = short_side
        self.interpolation = interpolation

    def __call__(self, image: Image.Image) -> Image.Image:
        """Apply resize degradation."""
        w, h = image.size

        if self.short_side is not None:
            # Resize so shorter side equals short_side
            if w < h:
                new_w = self.short_side
                new_h = int(h * self.short_side / w)
            else:
                new_h = self.short_side
                new_w = int(w * self.short_side / h)
        else:
            new_w = int(w * self.scale)
            new_h = int(h * self.scale)

        return image.resize((new_w, new_h), self.interpolation)

    def __repr__(self) -> str:
        if self.short_side:
            return f"Resize(short_side={self.short_side})"
        return f"Resize(scale={self.scale})"


class RandomResize:
    """Randomly resize to one of the target short sides.

    Args:
        short_sides: List of possible short side lengths.
        seed: Random seed.
    """

    def __init__(self, short_sides: List[int] = None, seed: Optional[int] = None):
        self.short_sides = short_sides or [512, 720, 1080]
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def __call__(self, image: Image.Image) -> Image.Image:
        short_side = int(self._rng.choice(self.short_sides))
        return Resize(short_side=short_side)(image)

    def __repr__(self) -> str:
        return f"RandomResize(short_sides={self.short_sides})"


class DownscaleUpscale:
    """Downscale then upscale to original size, simulating resolution loss.

    Args:
        scale: Downscale factor (e.g., 0.5 for half resolution).
    """

    def __init__(self, scale: float = 0.5):
        self.scale = scale

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        new_w = int(w * self.scale)
        new_h = int(h * self.scale)

        # Downscale
        small = image.resize((new_w, new_h), Image.BICUBIC)
        # Upscale back
        restored = small.resize((w, h), Image.BICUBIC)
        return restored

    def __repr__(self) -> str:
        return f"DownscaleUpscale(scale={self.scale})"
