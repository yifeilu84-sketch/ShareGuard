"""Color adjustment degradations."""

from typing import Optional

import numpy as np
from PIL import Image, ImageEnhance


class Brightness:
    """Brightness adjustment.

    Args:
        factor: Brightness factor. 1.0 = original, >1.0 = brighter, <1.0 = darker.
    """

    def __init__(self, factor: float = 1.2):
        self.factor = factor

    def __call__(self, image: Image.Image) -> Image.Image:
        enhancer = ImageEnhance.Brightness(image)
        return enhancer.enhance(self.factor)

    def __repr__(self) -> str:
        return f"Brightness(factor={self.factor})"


class Contrast:
    """Contrast adjustment.

    Args:
        factor: Contrast factor. 1.0 = original, >1.0 = more contrast.
    """

    def __init__(self, factor: float = 1.2):
        self.factor = factor

    def __call__(self, image: Image.Image) -> Image.Image:
        enhancer = ImageEnhance.Contrast(image)
        return enhancer.enhance(self.factor)

    def __repr__(self) -> str:
        return f"Contrast(factor={self.factor})"


class Saturation:
    """Saturation adjustment.

    Args:
        factor: Saturation factor. 1.0 = original, 0.0 = grayscale.
    """

    def __init__(self, factor: float = 1.2):
        self.factor = factor

    def __call__(self, image: Image.Image) -> Image.Image:
        enhancer = ImageEnhance.Color(image)
        return enhancer.enhance(self.factor)

    def __repr__(self) -> str:
        return f"Saturation(factor={self.factor})"


class Sharpness:
    """Sharpness adjustment.

    Args:
        factor: Sharpness factor. 1.0 = original, >1.0 = sharper.
    """

    def __init__(self, factor: float = 1.5):
        self.factor = factor

    def __call__(self, image: Image.Image) -> Image.Image:
        enhancer = ImageEnhance.Sharpness(image)
        return enhancer.enhance(self.factor)

    def __repr__(self) -> str:
        return f"Sharpness(factor={self.factor})"


class RandomColorJitter:
    """Random color jitter combining brightness, contrast, saturation, sharpness.

    Args:
        brightness_range: Range for brightness factor.
        contrast_range: Range for contrast factor.
        saturation_range: Range for saturation factor.
        sharpness_range: Range for sharpness factor.
        seed: Random seed.
    """

    def __init__(
        self,
        brightness_range: tuple = (0.8, 1.2),
        contrast_range: tuple = (0.8, 1.2),
        saturation_range: tuple = (0.8, 1.2),
        sharpness_range: tuple = (0.8, 1.5),
        seed: Optional[int] = None,
    ):
        self.brightness_range = brightness_range
        self.contrast_range = contrast_range
        self.saturation_range = saturation_range
        self.sharpness_range = sharpness_range
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def __call__(self, image: Image.Image) -> Image.Image:
        # Apply in random order
        transforms = [
            ("brightness", self.brightness_range),
            ("contrast", self.contrast_range),
            ("saturation", self.saturation_range),
            ("sharpness", self.sharpness_range),
        ]

        # Shuffle order
        indices = self._rng.permutation(len(transforms))

        for idx in indices:
            name, (low, high) = transforms[idx]
            factor = self._rng.uniform(low, high)

            if name == "brightness":
                image = Brightness(factor)(image)
            elif name == "contrast":
                image = Contrast(factor)(image)
            elif name == "saturation":
                image = Saturation(factor)(image)
            elif name == "sharpness":
                image = Sharpness(factor)(image)

        return image

    def __repr__(self) -> str:
        return (f"RandomColorJitter(brightness={self.brightness_range}, "
                f"contrast={self.contrast_range})")
