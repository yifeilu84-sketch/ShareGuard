"""Lightweight demo platform for ShareGuard detection backends."""

from .backends import (
    DetectionResult,
    MockDetectorBackend,
    RemoteDetectorBackend,
    ShareGuardDetectorBackend,
)
from .fusion_bundle import NoisyShareFusionBundleBackend

__all__ = [
    "DetectionResult",
    "MockDetectorBackend",
    "NoisyShareFusionBundleBackend",
    "RemoteDetectorBackend",
    "ShareGuardDetectorBackend",
]
