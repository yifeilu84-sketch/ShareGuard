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


def _boolean(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


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
    spai_checkpoint_sha256: Optional[str] = None
    model_version: str = "shareguard-screening-2026.08"
    include_propagation_views: bool = False
    public_score_decimals: int = 2
    rate_limit_per_minute: int = 0
    daily_quota: int = 0
    require_access_identity: bool = False
    edge_shared_secret: Optional[str] = None
    http_basic_username: Optional[str] = None
    http_basic_password: Optional[str] = None

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
            spai_checkpoint_sha256=env.get("SPAI_CHECKPOINT_SHA256") or None,
            model_version=env.get(
                "SHAREGUARD_MODEL_VERSION",
                "shareguard-screening-2026.08",
            ),
            include_propagation_views=_boolean(
                env,
                "SHAREGUARD_INCLUDE_PROPAGATION_VIEWS",
                False,
            ),
            public_score_decimals=_nonnegative_int(
                env,
                "SHAREGUARD_PUBLIC_SCORE_DECIMALS",
                2,
            ),
            rate_limit_per_minute=_nonnegative_int(
                env,
                "SHAREGUARD_RATE_LIMIT_PER_MINUTE",
                0,
            ),
            daily_quota=_nonnegative_int(
                env,
                "SHAREGUARD_DAILY_QUOTA",
                0,
            ),
            require_access_identity=_boolean(
                env,
                "SHAREGUARD_REQUIRE_ACCESS_IDENTITY",
                False,
            ),
            edge_shared_secret=env.get("SHAREGUARD_EDGE_SHARED_SECRET") or None,
            http_basic_username=env.get("SHAREGUARD_HTTP_BASIC_USERNAME") or None,
            http_basic_password=env.get("SHAREGUARD_HTTP_BASIC_PASSWORD") or None,
        )

    def validate(self) -> None:
        if self.mode not in {"local", "pilot", "production"}:
            raise ValueError(
                "SHAREGUARD_MODE must be local, pilot, or production"
            )
        basic_username_set = bool(self.http_basic_username)
        basic_password_set = bool(self.http_basic_password)
        if basic_username_set != basic_password_set:
            raise ValueError(
                "SHAREGUARD_HTTP_BASIC_USERNAME and "
                "SHAREGUARD_HTTP_BASIC_PASSWORD must be set together"
            )
        if self.api_token and basic_password_set:
            raise ValueError(
                "HTTP Basic authentication and SHAREGUARD_API_TOKEN cannot be "
                "combined because both use the Authorization header"
            )
        if (
            self.mode == "production"
            and not self.api_token
            and not self.require_access_identity
            and not basic_password_set
        ):
            raise ValueError(
                "Production requires an API token, Cloudflare Access identity, "
                "or HTTP Basic authentication"
            )
        if (
            self.mode == "production"
            and self.http_basic_password
            and len(self.http_basic_password) < 20
        ):
            raise ValueError(
                "SHAREGUARD_HTTP_BASIC_PASSWORD must be at least 20 characters "
                "in production"
            )
        if self.public_score_decimals > 4:
            raise ValueError("SHAREGUARD_PUBLIC_SCORE_DECIMALS cannot exceed 4")

    def is_origin_allowed(self, origin: Optional[str]) -> bool:
        if not origin:
            return False
        return origin.rstrip("/") in self.allowed_origins
