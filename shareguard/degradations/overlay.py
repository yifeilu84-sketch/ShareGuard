"""Overlay degradations: borders, text, watermarks."""

from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont


class WhiteBorder:
    """Add white border around the image.

    Args:
        pixels: Border width in pixels.
        color: Border color as RGB tuple.
    """

    def __init__(self, pixels: int = 20, color: Tuple[int, int, int] = (255, 255, 255)):
        self.pixels = pixels
        self.color = color

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        new_w = w + 2 * self.pixels
        new_h = h + 2 * self.pixels

        bordered = Image.new("RGB", (new_w, new_h), self.color)
        bordered.paste(image, (self.pixels, self.pixels))
        return bordered

    def __repr__(self) -> str:
        return f"WhiteBorder(pixels={self.pixels})"


class BlackBorder:
    """Add black border around the image.

    Args:
        pixels: Border width in pixels.
    """

    def __init__(self, pixels: int = 20):
        self.pixels = pixels

    def __call__(self, image: Image.Image) -> Image.Image:
        return WhiteBorder(pixels=self.pixels, color=(0, 0, 0))(image)

    def __repr__(self) -> str:
        return f"BlackBorder(pixels={self.pixels})"


class TextOverlay:
    """Add text overlay to simulate meme-like degradation.

    Args:
        text: Text to overlay. If None, uses placeholder text.
        position: Position of text ('top', 'bottom', 'center').
        font_size: Font size in pixels.
        color: Text color as RGB tuple.
        background: Background color behind text, or None for transparent.
    """

    def __init__(
        self,
        text: Optional[str] = None,
        position: str = "bottom",
        font_size: int = 32,
        color: Tuple[int, int, int] = (255, 255, 255),
        background: Optional[Tuple[int, int, int]] = (0, 0, 0),
    ):
        self.text = text or "SAMPLE TEXT"
        self.position = position
        self.font_size = font_size
        self.color = color
        self.background = background

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size
        result = image.copy()
        draw = ImageDraw.Draw(result)

        # Try to load a font
        try:
            font = ImageFont.truetype("arial.ttf", self.font_size)
        except (IOError, OSError):
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                                           self.font_size)
            except (IOError, OSError):
                font = ImageFont.load_default()

        # Get text bounding box
        bbox = draw.textbbox((0, 0), self.text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        # Calculate position
        x = (w - text_w) // 2
        if self.position == "top":
            y = 10
        elif self.position == "bottom":
            y = h - text_h - 10
        else:  # center
            y = (h - text_h) // 2

        # Draw background if specified
        if self.background:
            padding = 5
            draw.rectangle(
                [x - padding, y - padding, x + text_w + padding, y + text_h + padding],
                fill=self.background,
            )

        # Draw text
        draw.text((x, y), self.text, fill=self.color, font=font)
        return result

    def __repr__(self) -> str:
        return f"TextOverlay(position={self.position})"


class WatermarkOverlay:
    """Add semi-transparent watermark.

    Args:
        opacity: Watermark opacity (0-255).
        text: Watermark text.
    """

    def __init__(self, opacity: int = 64, text: str = "SAMPLE"):
        self.opacity = opacity
        self.text = text

    def __call__(self, image: Image.Image) -> Image.Image:
        w, h = image.size

        # Create watermark layer
        watermark = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(watermark)

        try:
            font = ImageFont.truetype("arial.ttf", max(20, min(w, h) // 10))
        except (IOError, OSError):
            font = ImageFont.load_default()

        # Draw watermark text diagonally
        bbox = draw.textbbox((0, 0), self.text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        # Position at center
        x = (w - text_w) // 2
        y = (h - text_h) // 2

        draw.text((x, y), self.text, fill=(255, 255, 255, self.opacity), font=font)

        # Composite
        result = Image.alpha_composite(image.convert("RGBA"), watermark)
        return result.convert("RGB")

    def __repr__(self) -> str:
        return f"WatermarkOverlay(opacity={self.opacity})"
