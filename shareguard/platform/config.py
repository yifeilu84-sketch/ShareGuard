"""Runtime configuration for the private ShareGuard platform."""

from dataclasses import dataclass
import os
from typing import Mapping, Optional, Tuple


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _nonnegative_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a non-negative integer") from exc
    if value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


@dataclass(frozen=True)
class PlatformConfig:
    """Security and capacity settings shared by HTTP and inference layers."""

    mode: str = "local"
    api_token: Optional[str] = None
    allowed_origins: Tuple[str, ...] = ()
    max_upload_bytes: int = 10 * 1024 * 1024
    max_image_pixels: int = 25_000_000
    max_inference_concurrency: int = 1
    max_waiting_requests: int = 8
    max_http_workers: int = 16
    bundle_sha256: Optional[str] = None
    model_version: str = "shareguard-private-v1"

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None) -> "PlatformConfig":
        env = os.environ if environ is None else environ
        origins = tuple(
            item.strip().rstrip("/")
            for item in env.get("SHAREGUARD_ALLOWED_ORIGINS", "").split(",")
            if item.strip()
        )
        return cls(
            mode=env.get("SHAREGUARD_MODE", "local").strip().lower(),
            api_token=env.get("SHAREGUARD_API_TOKEN") or None,
            allowed_origins=origins,
            max_upload_bytes=_positive_int(
                env,
                "SHAREGUARD_MAX_UPLOAD_BYTES",
                10 * 1024 * 1024,
            ),
            max_image_pixels=_positive_int(
                env,
                "SHAREGUARD_MAX_IMAGE_PIXELS",
                25_000_000,
            ),
            max_inference_concurrency=_positive_int(
                env,
                "SHAREGUARD_MAX_INFERENCE_CONCURRENCY",
                1,
            ),
            max_waiting_requests=_nonnegative_int(
                env,
                "SHAREGUARD_MAX_WAITING_REQUESTS",
                8,
            ),
            max_http_workers=_positive_int(
                env,
                "SHAREGUARD_MAX_HTTP_WORKERS",
                16,
            ),
            bundle_sha256=env.get("SHAREGUARD_BUNDLE_SHA256") or None,
            model_version=env.get(
                "SHAREGUARD_MODEL_VERSION",
                "shareguard-private-v1",
            ),
        )

    def validate(self) -> None:
        if self.mode not in {"local", "pilot", "production"}:
            raise ValueError(
                "SHAREGUARD_MODE must be local, pilot, or production"
            )
        if self.mode == "production" and not self.api_token:
            raise ValueError("SHAREGUARD_API_TOKEN is required in production")

    def is_origin_allowed(self, origin: Optional[str]) -> bool:
        if not origin:
            return False
        return origin.rstrip("/") in self.allowed_origins
