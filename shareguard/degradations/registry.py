"""Degradation registry for managing preset pipelines."""

from typing import Callable, Dict, Optional

from .jpeg import JPEG, WEBP, RandomJPEG
from .resize import Resize, RandomResize
from .crop import CenterCrop, RandomCrop
from .blur import GaussianBlur, MotionBlur
from .color import Brightness, Contrast, RandomColorJitter
from .overlay import WhiteBorder, TextOverlay
from .compose import DegradationComposer


class DegradationRegistry:
    """Registry for degradation presets.

    Usage:
        registry = DegradationRegistry()
        jpeg = registry.get("jpeg_q75")
        pipeline = registry.get("share_medium")
    """

    def __init__(self):
        self._presets: Dict[str, Callable] = {}
        self._register_defaults()

    def _register_defaults(self):
        """Register default degradation presets."""
        # Single degradations
        self.register("jpeg_q95", lambda: DegradationComposer([JPEG(quality=95)], "jpeg_q95"))
        self.register("jpeg_q75", lambda: DegradationComposer([JPEG(quality=75)], "jpeg_q75"))
        self.register("jpeg_q50", lambda: DegradationComposer([JPEG(quality=50)], "jpeg_q50"))
        self.register("jpeg_q30", lambda: DegradationComposer([JPEG(quality=30)], "jpeg_q30"))
        self.register("webp_q75", lambda: DegradationComposer([WEBP(quality=75)], "webp_q75"))
        self.register("resize_0.75", lambda: DegradationComposer([Resize(scale=0.75)], "resize_0.75"))
        self.register("resize_0.50", lambda: DegradationComposer([Resize(scale=0.50)], "resize_0.50"))
        self.register("gaussian_blur", lambda: DegradationComposer([GaussianBlur(radius=1.0)], "gaussian_blur"))
        self.register("motion_blur", lambda: DegradationComposer([MotionBlur(kernel_size=7)], "motion_blur"))
        self.register("brightness", lambda: DegradationComposer([Brightness(factor=1.2)], "brightness"))
        self.register("contrast", lambda: DegradationComposer([Contrast(factor=1.2)], "contrast"))
        self.register("crop_90", lambda: DegradationComposer([CenterCrop(ratio=0.9)], "crop_90"))
        self.register("crop_75", lambda: DegradationComposer([CenterCrop(ratio=0.75)], "crop_75"))

        # Compound degradations
        self.register("share_light", lambda: DegradationComposer([
            Resize(short_side=1080), JPEG(quality=85)
        ], "share_light"))

        self.register("share_medium", lambda: DegradationComposer([
            Resize(short_side=720), CenterCrop(ratio=0.95), JPEG(quality=70)
        ], "share_medium"))

        self.register("share_heavy", lambda: DegradationComposer([
            Resize(short_side=512), GaussianBlur(radius=0.6), JPEG(quality=50)
        ], "share_heavy"))

        self.register("screenshot_like", lambda: DegradationComposer([
            WhiteBorder(pixels=20), Resize(short_side=1080),
            JPEG(quality=75), CenterCrop(ratio=0.92)
        ], "screenshot_like"))

        self.register("meme_like", lambda: DegradationComposer([
            Resize(short_side=768), TextOverlay(position="bottom"), JPEG(quality=70)
        ], "meme_like"))

        self.register("social_repost", lambda: DegradationComposer([
            JPEG(quality=85), Resize(short_side=720),
            JPEG(quality=65), CenterCrop(ratio=0.95)
        ], "social_repost"))

        # Platform-inspired
        self.register("x_like", lambda: DegradationComposer([
            Resize(short_side=2048), CenterCrop(ratio=0.95), JPEG(quality=80)
        ], "x_like"))

        self.register("facebook_like", lambda: DegradationComposer([
            Resize(short_side=1440), GaussianBlur(radius=0.3), JPEG(quality=75)
        ], "facebook_like"))

        self.register("whatsapp_like", lambda: DegradationComposer([
            Resize(short_side=1600), JPEG(quality=65)
        ], "whatsapp_like"))

        self.register("telegram_like", lambda: DegradationComposer([
            Resize(short_side=1280), JPEG(quality=80)
        ], "telegram_like"))

    def register(self, name: str, factory: Callable):
        """Register a degradation preset."""
        self._presets[name] = factory

    def get(self, name: str) -> DegradationComposer:
        """Get a degradation preset by name."""
        if name not in self._presets:
            raise ValueError(f"Unknown preset: {name}. Available: {list(self._presets.keys())}")
        return self._presets[name]()

    def list_presets(self) -> list:
        """List all available presets."""
        return list(self._presets.keys())
