"""Self-contained HTTP platform for ShareGuard demo inference."""

import argparse
import base64
import binascii
from email import policy
from email.parser import BytesParser
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import os
from pathlib import Path
import secrets
from threading import BoundedSemaphore
from typing import Mapping, Optional
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

from .backends import (
    DetectorBackend,
    MockDetectorBackend,
    RemoteDetectorBackend,
    ShareGuardDetectorBackend,
)
from .config import PlatformConfig
from .fusion_bundle import NoisyShareFusionBundleBackend
from .model_artifacts import resolve_bundle_path, resolve_checkpoint_path
from .product import build_authenticity_report, make_propagation_views
from .rate_limit import MemoryRateLimiter
from .service import AnalysisError, AnalysisService


STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_ASSET_ROUTES = {
    "/dossier.css": ("dossier.css", "text/css; charset=utf-8"),
    "/dossier.js": ("dossier.js", "application/javascript; charset=utf-8"),
    "/i18n.js": ("i18n.js", "application/javascript; charset=utf-8"),
    "/crypto-worker.js": ("crypto-worker.js", "application/javascript; charset=utf-8"),
    "/verifier.html": ("verifier.html", "text/html; charset=utf-8"),
    "/verifier.js": ("verifier.js", "application/javascript; charset=utf-8"),
}
MULTIPART_OVERHEAD_BYTES = 64 * 1024
ACCESS_IDENTITY_HEADER = "Cf-Access-Authenticated-User-Email"
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; "
    "worker-src 'self'; "
    "connect-src 'self'; "
    "base-uri 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Threaded HTTP server with a hard cap on active request threads."""

    daemon_threads = True

    def __init__(self, server_address, handler_class, max_workers: int = 16):
        if max_workers < 1:
            raise ValueError("max_workers must be at least 1")
        self._request_slots = BoundedSemaphore(max_workers)
        super().__init__(server_address, handler_class)

    def process_request(self, request, client_address):
        self._request_slots.acquire()
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def json_bytes(payload, status: int = 200):
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    return status, "application/json; charset=utf-8", data


def analyze_image_bytes(image_bytes: bytes, backend: DetectorBackend, filename: str):
    try:
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Uploaded file is not a readable image.") from exc
    payload = backend.analyze(image, filename=filename).to_dict()
    payload["propagation_views"] = make_propagation_views(image)
    payload["report"] = build_authenticity_report(payload)
    return payload


def parse_multipart_image(content_type: str, body: bytes):
    if "boundary=" not in content_type:
        raise ValueError("Missing multipart boundary")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\n"
        b"MIME-Version: 1.0\r\n\r\n" + body
    )
    if not message.is_multipart():
        raise ValueError("Request body is not multipart data")
    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if not disposition.startswith("form-data"):
            continue
        if part.get_param("name", header="content-disposition") != "image":
            continue
        filename = part.get_filename() or "upload"
        payload = part.get_payload(decode=True)
        if not payload:
            raise ValueError("Uploaded image is empty")
        return payload, filename
    raise ValueError("Missing multipart field: image")


def read_multipart_image(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("Content-Length", "0"))
    body = handler.rfile.read(length)
    return parse_multipart_image(handler.headers.get("Content-Type", ""), body)


def bearer_token_is_valid(header_value: Optional[str], expected_token: Optional[str]):
    if not expected_token:
        return True
    prefix = "Bearer "
    if not header_value or not header_value.startswith(prefix):
        return False
    return secrets.compare_digest(header_value[len(prefix):], expected_token)


def basic_auth_is_valid(
    header_value: Optional[str],
    expected_username: Optional[str],
    expected_password: Optional[str],
) -> bool:
    if not expected_username and not expected_password:
        return True
    if not header_value:
        return False
    scheme, separator, encoded = header_value.partition(" ")
    if not separator or scheme.lower() != "basic" or not encoded:
        return False
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return False
    username, separator, password = decoded.partition(":")
    if not separator:
        return False
    return secrets.compare_digest(
        username,
        expected_username or "",
    ) and secrets.compare_digest(
        password,
        expected_password or "",
    )


def error_payload(request_id: str, code: str, message: str):
    return {
        "request_id": request_id,
        "error": {"code": code, "message": message},
    }


def request_actor(headers, client_address, require_access_identity: bool) -> str:
    identity = str(headers.get(ACCESS_IDENTITY_HEADER, "")).strip().lower()
    if identity:
        invalid_identity = (
            len(identity) > 254
            or "@" not in identity
            or any(ch.isspace() for ch in identity)
        )
        if invalid_identity:
            raise AnalysisError(
                401,
                "invalid_access_identity",
                "Access identity is invalid.",
            )
        source = f"access:{identity}"
    elif require_access_identity:
        raise AnalysisError(
            401,
            "access_identity_required",
            "Please authenticate before using the private analysis service.",
        )
    else:
        source = f"client:{client_address[0]}"
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def make_handler(
    backend: DetectorBackend,
    config: Optional[PlatformConfig] = None,
    service: Optional[AnalysisService] = None,
):
    runtime_config = config or PlatformConfig()
    analysis_service = service or AnalysisService(backend, runtime_config)
    rate_limiter = MemoryRateLimiter(
        per_minute=runtime_config.rate_limit_per_minute,
        per_day=runtime_config.daily_quota,
    )

    class ShareGuardHandler(BaseHTTPRequestHandler):
        server_version = "ShareGuard"
        sys_version = ""

        def send_payload(
            self,
            status: int,
            content_type: str,
            data: bytes,
            extra_headers=None,
        ):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            self.send_header(
                "Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=()",
            )
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
            if self.path.startswith(("/api/", "/v1/", "/health")):
                self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin")
            if runtime_config.is_origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin.rstrip("/"))
                self.send_header("Vary", "Origin")
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if data:
                self.wfile.write(data)

        def send_json(self, payload, status=200, extra_headers=None):
            response_status, content_type, data = json_bytes(payload, status=status)
            self.send_payload(
                response_status,
                content_type,
                data,
                extra_headers=extra_headers,
            )

        def new_request_id(self):
            return f"sg_req_{uuid4().hex}"

        def require_http_basic_auth(self) -> bool:
            if basic_auth_is_valid(
                self.headers.get("Authorization"),
                runtime_config.http_basic_username,
                runtime_config.http_basic_password,
            ):
                return True
            request_id = self.new_request_id()
            self.send_json(
                error_payload(
                    request_id,
                    "authentication_required",
                    "Authentication is required for this private demo.",
                ),
                status=401,
                extra_headers={
                    "Cache-Control": "no-store",
                    "WWW-Authenticate": (
                        'Basic realm="ShareGuard private demo", charset="UTF-8"'
                    ),
                },
            )
            return False

        def do_OPTIONS(self):
            if not self.require_http_basic_auth():
                return
            request_id = self.new_request_id()
            origin = self.headers.get("Origin")
            if origin and not runtime_config.is_origin_allowed(origin):
                self.send_json(
                    error_payload(
                        request_id,
                        "origin_not_allowed",
                        "该来源不允许跨域访问此服务。",
                    ),
                    status=403,
                )
                return
            self.send_payload(
                204,
                "text/plain; charset=utf-8",
                b"",
                extra_headers={
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": (
                        "Authorization, Content-Type, X-File-Name"
                    ),
                    "Access-Control-Max-Age": "600",
                },
            )

        def do_GET(self):
            if not self.require_http_basic_auth():
                return
            request_path = self.path.split("?", 1)[0]
            if request_path in {"/", "/index.html"}:
                path = STATIC_DIR / "index.html"
                self.send_payload(200, "text/html; charset=utf-8", path.read_bytes())
                return
            if request_path == "/favicon.ico":
                self.send_payload(
                    204,
                    "image/x-icon",
                    b"",
                    extra_headers={"Cache-Control": "public, max-age=86400"},
                )
                return
            static_asset = STATIC_ASSET_ROUTES.get(request_path)
            if static_asset:
                filename, content_type = static_asset
                path = STATIC_DIR / filename
                self.send_payload(
                    200,
                    content_type,
                    path.read_bytes(),
                    extra_headers={"Cache-Control": "no-cache"},
                )
                return
            if request_path == "/assets/flagship-event.jpg":
                path = STATIC_DIR / "assets" / "flagship-event.jpg"
                self.send_payload(
                    200,
                    "image/jpeg",
                    path.read_bytes(),
                    extra_headers={"Cache-Control": "public, max-age=86400"},
                )
                return
            if self.path in {"/health", "/v1/health"}:
                self.send_json({
                    "request_id": self.new_request_id(),
                    "status": "ok",
                    "model_version": runtime_config.model_version,
                    "routes": [
                        "/",
                        "/v1/health",
                        "/v1/ready",
                        "/v1/analyze",
                    ],
                })
                return
            if self.path == "/v1/ready":
                checker = getattr(analysis_service, "is_ready", None)
                ready = bool(checker()) if checker else True
                self.send_json(
                    {
                        "request_id": self.new_request_id(),
                        "status": "ready" if ready else "not_ready",
                        "model_version": runtime_config.model_version,
                    },
                    status=200 if ready else 503,
                )
                return
            request_id = self.new_request_id()
            self.send_json(
                error_payload(request_id, "not_found", "请求的资源不存在。"),
                status=404,
            )

        def do_POST(self):
            if not self.require_http_basic_auth():
                return
            request_id = self.new_request_id()
            if self.path not in {"/api/analyze", "/v1/analyze"}:
                self.send_json(
                    error_payload(request_id, "not_found", "请求的资源不存在。"),
                    status=404,
                )
                return

            try:
                if not bearer_token_is_valid(
                    self.headers.get("Authorization"),
                    runtime_config.api_token,
                ):
                    raise AnalysisError(
                        401,
                        "unauthorized",
                        "缺少有效的访问凭证。",
                    )
                actor = request_actor(
                    self.headers,
                    self.client_address,
                    runtime_config.require_access_identity,
                )
                limit = rate_limiter.consume(actor)
                if not limit.allowed:
                    raise AnalysisError(
                        429,
                        "rate_limited",
                        "Request quota exceeded. Please try again later.",
                        headers={"Retry-After": str(limit.retry_after)},
                    )
                content_type = self.headers.get("Content-Type", "")
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError as exc:
                    raise AnalysisError(
                        400,
                        "invalid_request",
                        "请求长度无效。",
                    ) from exc
                if length < 0:
                    raise AnalysisError(
                        400,
                        "invalid_request",
                        "请求长度无效。",
                    )
                body_limit = runtime_config.max_upload_bytes
                if content_type.startswith("multipart/form-data"):
                    body_limit += MULTIPART_OVERHEAD_BYTES
                if length > body_limit:
                    raise AnalysisError(
                        413,
                        "payload_too_large",
                        "图片文件超过允许的大小。",
                    )
                if content_type.startswith("multipart/form-data"):
                    try:
                        image_bytes, filename = read_multipart_image(self)
                    except ValueError as exc:
                        raise AnalysisError(
                            400,
                            "missing_image",
                            "请求中缺少有效的 image 图片字段。",
                        ) from exc
                else:
                    image_bytes = self.rfile.read(length)
                    filename = self.headers.get("X-File-Name", "upload")
                outcome = analysis_service.analyze(
                    image_bytes,
                    filename,
                    request_id,
                )
                response_headers = {}
                if isinstance(backend, MockDetectorBackend):
                    response_headers["X-ShareGuard-Demo"] = "true"
                if self.path == "/v1/analyze":
                    self.send_json(
                        outcome.public_payload,
                        extra_headers=response_headers,
                    )
                else:
                    self.send_json(
                        outcome.legacy_payload,
                        extra_headers={"Deprecation": "true", **response_headers},
                    )
            except AnalysisError as exc:
                self.send_json(
                    error_payload(request_id, exc.code, exc.public_message),
                    status=exc.status,
                    extra_headers=exc.headers,
                )
            except Exception:
                print(f"{request_id} status=500 code=internal_error")
                self.send_json(
                    error_payload(
                        request_id,
                        "internal_error",
                        "服务暂时无法完成分析，请稍后重试。",
                    ),
                    status=500,
                )

        def log_message(self, fmt, *args):
            print("%s - %s" % (self.address_string(), fmt % args))

    return ShareGuardHandler


def build_backend(
    name: str,
    checkpoint: Optional[str],
    device: Optional[str],
    remote_url: Optional[str] = None,
    remote_token: Optional[str] = None,
    model_url: Optional[str] = None,
    model_cache: Optional[str] = None,
    bundle: Optional[str] = None,
    bundle_url: Optional[str] = None,
    bundle_cache: Optional[str] = None,
    expected_sha256: Optional[str] = None,
):
    if name == "mock":
        return MockDetectorBackend()
    if name == "shareguard":
        resolved = resolve_checkpoint_path(
            checkpoint=checkpoint,
            model_url=model_url,
            cache_dir=Path(model_cache) if model_cache else None,
            expected_sha256=expected_sha256,
        )
        return ShareGuardDetectorBackend(str(resolved), device=device)
    if name == "remote":
        if not remote_url:
            raise ValueError("--remote-url is required when --backend remote")
        return RemoteDetectorBackend(remote_url, token=remote_token)
    if name == "fusion-bundle":
        resolved = resolve_bundle_path(
            bundle_path=bundle,
            bundle_url=bundle_url,
            cache_dir=Path(bundle_cache) if bundle_cache else None,
            expected_sha256=expected_sha256,
        )
        return NoisyShareFusionBundleBackend(str(resolved), device=device)
    raise ValueError(f"Unknown backend: {name}")


def run_server(
    host: str,
    port: int,
    backend: DetectorBackend,
    config: Optional[PlatformConfig] = None,
    service: Optional[AnalysisService] = None,
):
    runtime_config = config or PlatformConfig()
    if (
        runtime_config.require_access_identity
        and host not in {"127.0.0.1", "localhost", "::1"}
    ):
        raise ValueError(
            "Cloudflare Access identity headers may only be trusted on a loopback bind"
        )
    analysis_service = service or AnalysisService(backend, runtime_config)
    server = BoundedThreadingHTTPServer(
        (host, port),
        make_handler(backend, runtime_config, analysis_service),
        max_workers=runtime_config.max_http_workers,
    )
    print(f"ShareGuard platform running on http://{host}:{port}")
    print(f"Mode: {runtime_config.mode}")
    print(f"Model version: {runtime_config.model_version}")
    server.serve_forever()


def build_parser(
    environ: Optional[Mapping[str, str]] = None,
) -> argparse.ArgumentParser:
    env = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(description="Run ShareGuard demo platform")
    parser.add_argument(
        "--host",
        default=env.get("SHAREGUARD_HOST", env.get("HOST", "127.0.0.1")),
    )
    parser.add_argument("--port", type=int, default=int(env.get("PORT", "7860")))
    parser.add_argument(
        "--backend",
        choices=["mock", "shareguard", "remote", "fusion-bundle"],
        default=env.get("SHAREGUARD_BACKEND", "mock"),
    )
    parser.add_argument("--checkpoint", default=env.get("CHECKPOINT"))
    parser.add_argument("--model-url", default=env.get("MODEL_URL"))
    parser.add_argument(
        "--model-cache",
        default=env.get("SHAREGUARD_MODEL_CACHE"),
    )
    parser.add_argument("--device", default=env.get("SHAREGUARD_DEVICE"))
    parser.add_argument("--remote-url", default=env.get("REMOTE_URL"))
    parser.add_argument("--remote-token", default=env.get("REMOTE_TOKEN"))
    parser.add_argument("--bundle", default=env.get("BUNDLE"))
    parser.add_argument("--bundle-url", default=env.get("BUNDLE_URL"))
    parser.add_argument(
        "--bundle-cache",
        default=env.get("SHAREGUARD_MODEL_CACHE"),
    )
    return parser


def validate_model_source(config: PlatformConfig, args) -> None:
    if config.mode not in {"pilot", "production"}:
        return
    if config.mode == "production" and args.backend == "mock":
        raise ValueError("mock backend is not allowed in production")
    if args.backend == "fusion-bundle":
        if args.bundle and Path(args.bundle).expanduser().is_dir():
            raise ValueError(
                "pilot and production require a verified archive or signed URL"
            )
        if not config.bundle_sha256:
            raise ValueError(
                "SHAREGUARD_BUNDLE_SHA256 is required for pilot or production archives"
            )
    if args.backend == "shareguard" and not config.bundle_sha256:
        raise ValueError(
            "SHAREGUARD_BUNDLE_SHA256 is required for pilot or production checkpoints"
        )


def main(argv=None, environ: Optional[Mapping[str, str]] = None):
    env = os.environ if environ is None else environ
    config = PlatformConfig.from_env(env)
    config.validate()
    parser = build_parser(env)
    args = parser.parse_args(argv)
    validate_model_source(config, args)

    backend = build_backend(
        args.backend,
        args.checkpoint,
        args.device,
        remote_url=args.remote_url,
        remote_token=args.remote_token,
        model_url=args.model_url,
        model_cache=args.model_cache,
        bundle=args.bundle,
        bundle_url=args.bundle_url,
        bundle_cache=args.bundle_cache,
        expected_sha256=config.bundle_sha256,
    )
    service = AnalysisService(backend, config)
    if config.mode in {"pilot", "production"}:
        service.warmup()
    run_server(args.host, args.port, backend, config=config, service=service)


if __name__ == "__main__":
    main()
