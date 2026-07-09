"""Self-contained HTTP platform for ShareGuard demo inference."""

import argparse
from email import policy
from email.parser import BytesParser
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Optional

from PIL import Image, UnidentifiedImageError

from .backends import (
    DetectorBackend,
    MockDetectorBackend,
    RemoteDetectorBackend,
    ShareGuardDetectorBackend,
)
from .fusion_bundle import NoisyShareFusionBundleBackend
from .model_artifacts import resolve_bundle_path, resolve_checkpoint_path
from .product import build_authenticity_report, make_propagation_views


STATIC_DIR = Path(__file__).resolve().parent / "static"


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


def make_handler(backend: DetectorBackend):
    class ShareGuardHandler(BaseHTTPRequestHandler):
        server_version = "ShareGuardPlatform/0.1"

        def send_payload(self, status: int, content_type: str, data: bytes):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_payload(204, "text/plain", b"")

        def do_GET(self):
            if self.path in {"/", "/index.html"}:
                path = STATIC_DIR / "index.html"
                self.send_payload(200, "text/html; charset=utf-8", path.read_bytes())
                return
            if self.path == "/health":
                status, content_type, data = json_bytes({
                    "status": "ok",
                    "backend": backend.name,
                    "routes": ["/", "/health", "/api/analyze"],
                })
                self.send_payload(status, content_type, data)
                return
            status, content_type, data = json_bytes({"error": "Not found"}, status=404)
            self.send_payload(status, content_type, data)

        def do_POST(self):
            if self.path != "/api/analyze":
                status, content_type, data = json_bytes({"error": "Not found"}, status=404)
                self.send_payload(status, content_type, data)
                return

            try:
                content_type = self.headers.get("Content-Type", "")
                if content_type.startswith("multipart/form-data"):
                    image_bytes, filename = read_multipart_image(self)
                else:
                    length = int(self.headers.get("Content-Length", "0"))
                    image_bytes = self.rfile.read(length)
                    filename = self.headers.get("X-File-Name", "upload")
                payload = analyze_image_bytes(image_bytes, backend, filename)
                status, content_type, data = json_bytes(payload)
            except Exception as exc:
                status, content_type, data = json_bytes(
                    {"error": str(exc), "backend": backend.name},
                    status=400,
                )
            self.send_payload(status, content_type, data)

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
):
    if name == "mock":
        return MockDetectorBackend()
    if name == "shareguard":
        resolved = resolve_checkpoint_path(
            checkpoint=checkpoint,
            model_url=model_url,
            cache_dir=Path(model_cache) if model_cache else None,
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
        )
        return NoisyShareFusionBundleBackend(str(resolved), device=device)
    raise ValueError(f"Unknown backend: {name}")


def run_server(host: str, port: int, backend: DetectorBackend):
    server = ThreadingHTTPServer((host, port), make_handler(backend))
    print(f"ShareGuard platform running on http://{host}:{port}")
    print(f"Backend: {backend.name}")
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Run ShareGuard demo platform")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument(
        "--backend",
        choices=["mock", "shareguard", "remote", "fusion-bundle"],
        default="mock",
    )
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--model-url", default=None)
    parser.add_argument("--model-cache", default=None)
    parser.add_argument("--device", default=None)
    parser.add_argument("--remote-url", default=None)
    parser.add_argument("--remote-token", default=None)
    parser.add_argument("--bundle", default=None)
    parser.add_argument("--bundle-url", default=None)
    parser.add_argument("--bundle-cache", default=None)
    args = parser.parse_args()

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
    )
    run_server(args.host, args.port, backend)


if __name__ == "__main__":
    main()
