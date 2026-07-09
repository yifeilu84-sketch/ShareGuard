"""Blur degradation."""

from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageFilter


class GaussianBlur:
    """Gaussian blur degradation.

    Args:
        radius: Blur radius. Higher = more blur.
    """

    def __init__(self, radius: float = 1.0):
        self.radius = radius

    def __call__(self, image: Image.Image) -> Image.Image:
        return image.filter(ImageFilter.GaussianBlur(radius=self.radius))

    def __repr__(self) -> str:
        return f"GaussianBlur(radius={self.radius})"


class MotionBlur:
    """Motion blur degradation using a directional kernel.

    Args:
        kernel_size: Size of the motion blur kernel.
        angle: Angle of motion in degrees (0 = horizontal).
    """

    def __init__(self, kernel_size: int = 7, angle: float = 0):
        self.kernel_size = kernel_size
        self.angle = angle

    def _create_kernel(self) -> np.ndarray:
        """Create motion blur kernel."""
        kernel = np.zeros((self.kernel_size, self.kernel_size))
        center = self.kernel_size // 2

        # Convert angle to radians
        rad = np.radians(self.angle)
        cos_a, sin_a = np.cos(rad), np.sin(rad)

        # Draw line through center
        for i in range(self.kernel_size):
            offset = i - center
            x = int(center + offset * cos_a)
            y = int(center + offset * sin_a)
            if 0 <= x < self.kernel_size and 0 <= y < self.kernel_size:
                kernel[y, x] = 1.0

        # Normalize
        if kernel.sum() > 0:
            kernel /= kernel.sum()

        return kernel

    def __call__(self, image: Image.Image) -> Image.Image:
        # Use PIL's built-in filter as approximation
        # For more accurate motion blur, use cv2.filter2D
        try:
            import cv2
            img_array = np.array(image)
            kernel = self._create_kernel()
            blurred = cv2.filter2D(img_array, -1, kernel)
            return Image.fromarray(blurred)
        except ImportError:
            # Fallback to PIL blur
            return image.filter(ImageFilter.GaussianBlur(radius=self.kernel_size / 3))

    def __repr__(self) -> str:
        return f"MotionBlur(kernel={self.kernel_size}, angle={self.angle})"


class RandomBlur:
    """Random blur degradation.

    Args:
        blur_types: List of blur types to choose from.
        seed: Random seed.
    """

    def __init__(self, blur_types: list = None, seed: Optional[int] = None):
        self.blur_types = blur_types or ["gaussian", "motion"]
        self.seed = seed
        self._rng = np.random.RandomState(seed)

    def __call__(self, image: Image.Image) -> Image.Image:
        blur_type = self._rng.choice(self.blur_types)

        if blur_type == "gaussian":
            radius = self._rng.uniform(0.5, 2.0)
            return GaussianBlur(radius=radius)(image)
        elif blur_type == "motion":
            kernel = self._rng.choice([5, 7, 9])
            angle = self._rng.uniform(0, 180)
            return MotionBlur(kernel_size=kernel, angle=angle)(image)
        else:
            return image

    def __repr__(self) -> str:
        return f"RandomBlur(types={self.blur_types})"
