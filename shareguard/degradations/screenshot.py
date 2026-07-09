"""Screenshot-like degradation simulation.

Simulates the effect of taking a screenshot of an image,
which typically involves border artifacts, slight resize,
and recompression.
"""

from typing import Optional, Tuple

import numpy as np
from PIL import Image

from .jpeg import JPEG
from .resize import Resize
from .overlay import WhiteBorder, BlackBorder


class ScreenshotSimulation:
    """Simulate screenshot-like degradation.

    Adds border, resizes, and applies JPEG compression
    to simulate taking a screenshot of an image.

    Args:
        border_pixels: Width of border to add.
        border_color: Color of border ('white' or 'black').
        short_side: Target short side after resize.
        jpeg_quality: JPEG quality for recompression.
        seed: Random seed.
    """

    def __init__(
        self,
        border_pixels: int = 20,
        border_color: str = "white",
        short_side: int = 1080,
        jpeg_quality: int = 75,
        seed: Optional[int] = None,
    ):
        self.border_pixels = border_pixels
        self.border_color = border_color
        self.short_side = short_side
        self.jpeg_quality = jpeg_quality
        self.seed = seed
        self._rng = np.random.RandomState(seed)

        # Build pipeline
        if border_color == "white":
            self.border = WhiteBorder(pixels=border_pixels)
        else:
            self.border = BlackBorder(pixels=border_pixels)

        self.resize = Resize(short_side=short_side)
        self.jpeg = JPEG(quality=jpeg_quality)

    def __call__(self, image: Image.Image) -> Image.Image:
        # Add border
        img = self.border(image)
        # Resize
        img = self.resize(img)
        # Crop slightly (simulate imperfect screenshot)
        w, h = img.size
        crop_ratio = 0.92
        new_w = int(w * crop_ratio)
        new_h = int(h * crop_ratio)
        left = (w - new_w) // 2
        top = (h - new_h) // 2
        img = img.crop((left, top, left + new_w, top + new_h))
        # Resize back
        img = img.resize((w, h), Image.BICUBIC)
        # JPEG compress
        img = self.jpeg(img)
        return img

    def __repr__(self) -> str:
        return (f"ScreenshotSimulation(border={self.border_pixels}, "
                f"short_side={self.short_side}, jpeg={self.jpeg_quality})")


class ScreenCapture:
    """Simpler screen capture simulation.

    Just adds a slight border and recompresses.

    Args:
        border_ratio: Fraction of image size to add as border.
        jpeg_quality: JPEG quality.
    """

    def __init__(self, border_ratio: float = 0.02, jpeg_quality: int = 80):
        self.border_ratio = border_ratio
        self.jpeg_quality = jpeg_quality

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        border_pixels = int(min(w, h) * self.border_ratio)

        # Add border
        bordered = WhiteBorder(pixels=border_pixels)(image)

        # Slight resize to simulate screen resolution
        new_w = int(w * 0.95)
        new_h = int(h * 0.95)
        resized = bordered.resize((new_w, new_h), Image.BICUBIC)

        # JPEG compress
        return JPEG(quality=self.jpeg_quality)(resized)

    def __repr__(self) -> str:
        return f"ScreenCapture(border_ratio={self.border_ratio})"
