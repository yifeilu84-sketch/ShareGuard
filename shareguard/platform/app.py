"""Self-contained HTTP platform for ShareGuard demo inference."""

import argparse
from email import policy
from email.parser import BytesParser
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlsplit

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
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def resolve_static_path(request_path: str) -> Optional[Path]:
    """Resolve one public static path without allowing directory traversal."""

    path = unquote(urlsplit(request_path).path)
    relative = "index.html" if path in {"", "/"} else path.lstrip("/")
    try:
        root = STATIC_DIR.resolve()
        candidate = (root / relative).resolve()
        candidate.relative_to(root)
    except (OSError, ValueError):
        return None
    return candidate if candidate.is_file() else None


def public_analysis_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Return the product response without model internals or filesystem details."""

    backend = "mock" if payload.get("backend") == "mock" else "private-inference"
    probability = float(payload.get("probability_ai_generated", 0.0))
    confidence = float(payload.get("confidence", 0.0))
    risk_level = str(payload.get("risk_level", "uncertain"))
    decision = {
        "high": "hold",
        "medium": "review",
        "uncertain": "review",
        "low": "allow",
    }.get(risk_level, "review")
    filename = str(payload.get("file_name") or "upload").replace("\\", "/").rsplit("/", 1)[-1][:255]
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    report = payload.get("report") if isinstance(payload.get("report"), dict) else {}

    sections = []
    for section in report.get("sections") or []:
        if not isinstance(section, dict):
            continue
        body = section.get("body")
        if not body and isinstance(section.get("items"), list):
            body = "；".join(str(item) for item in section["items"] if item)
        sections.append({
            "title": str(section.get("title") or "记录"),
            "body": str(body or "-"),
        })

    notes = report.get("notes") or report.get("review_notes") or []
    notes = [str(note) for note in notes if note][:4]
    conclusion = str(report.get("conclusion") or "需人工复核")
    summary = str(
        report.get("summary")
        or f"{conclusion}。系统给出 {probability * 100:.1f}% 的AI生成风险，置信度为 {confidence * 100:.1f}%。"
    )

    propagation_views = []
    for index, view in enumerate(payload.get("propagation_views") or []):
        if not isinstance(view, dict):
            continue
        propagation_views.append({
            "id": str(view.get("id") or f"view-{index + 1}"),
            "label": str(view.get("label") or f"传播版本 {index + 1}"),
            "width": int(view.get("width") or 0),
            "height": int(view.get("height") or 0),
            "data_url": str(view.get("data_url") or view.get("image_data_url") or ""),
        })

    return {
        "file_name": filename,
        "label": str(payload.get("label") or "unknown"),
        "probability_ai_generated": probability,
        "confidence": confidence,
        "risk_level": risk_level,
        "decision": decision,
        "uncertainty": str(report.get("uncertainty") or "中等"),
        "backend": backend,
        "image": {
            "width": int(image.get("width") or 0),
            "height": int(image.get("height") or 0),
            "mode": str(image.get("mode") or "RGB"),
        },
        "propagation_views": propagation_views,
        "report": {
            "product": "ShareGuard影像鉴真",
            "report_id": str(report.get("report_id") or ""),
            "generated_at": str(report.get("generated_at") or ""),
            "subject": {
                "file_name": filename,
                "image_size": str((report.get("subject") or {}).get("image_size") or "-"),
                "backend": backend,
            },
            "conclusion": conclusion,
            "summary": summary,
            "risk_level": risk_level,
            "ai_probability": probability,
            "confidence": confidence,
            "uncertainty": str(report.get("uncertainty") or "中等"),
            "recommended_action": str(report.get("recommended_action") or "进入人工复核流程。"),
            "sections": sections,
            "notes": notes,
            "disclaimer": str(
                report.get("disclaimer")
                or "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。"
            ),
        },
    }


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


def request_content_length(handler: BaseHTTPRequestHandler) -> int:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError as exc:
        raise ValueError("Invalid Content-Length header") from exc
    if length <= 0:
        raise ValueError("Uploaded image is empty")
    if length > MAX_UPLOAD_BYTES:
        raise ValueError("Uploaded image exceeds the 20 MB limit")
    return length


def read_multipart_image(handler: BaseHTTPRequestHandler):
    length = request_content_length(handler)
    body = handler.rfile.read(length)
    return parse_multipart_image(handler.headers.get("Content-Type", ""), body)


def make_handler(backend: DetectorBackend):
    class ShareGuardHandler(BaseHTTPRequestHandler):
        server_version = "ShareGuardPlatform/1.0"

        def send_payload(
            self,
            status: int,
            content_type: str,
            data: bytes,
            extra_headers: Optional[Dict[str, str]] = None,
        ):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            if content_type.startswith("text/html"):
                self.send_header(
                    "Content-Security-Policy",
                    "default-src 'self'; img-src 'self' data: blob:; "
                    "script-src 'self'; style-src 'self' 'unsafe-inline'; "
                    "connect-src 'self'; worker-src 'self' blob:; "
                    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                )
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_payload(204, "text/plain; charset=utf-8", b"", {"Allow": "GET, POST, OPTIONS"})

        def do_GET(self):
            request_path = urlsplit(self.path).path
            if request_path == "/health":
                status, content_type, data = json_bytes({
                    "status": "ok",
                    "service": "shareguard-inference",
                    "mode": "demo" if backend.name == "mock" else "private-inference",
                })
                self.send_payload(status, content_type, data)
                return

            path = resolve_static_path(self.path)
            if path is not None:
                content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                if path.suffix == ".js":
                    content_type = "application/javascript"
                if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
                    content_type += "; charset=utf-8"
                self.send_payload(200, content_type, path.read_bytes())
                return
            status, content_type, data = json_bytes({"error": "Not found"}, status=404)
            self.send_payload(status, content_type, data)

        def do_POST(self):
            if urlsplit(self.path).path != "/api/analyze":
                status, content_type, data = json_bytes({"error": "Not found"}, status=404)
                self.send_payload(status, content_type, data)
                return

            try:
                content_type = self.headers.get("Content-Type", "")
                if content_type.startswith("multipart/form-data"):
                    image_bytes, filename = read_multipart_image(self)
                else:
                    length = request_content_length(self)
                    image_bytes = self.rfile.read(length)
                    filename = self.headers.get("X-File-Name", "upload")
                payload = public_analysis_payload(analyze_image_bytes(image_bytes, backend, filename))
                status, content_type, data = json_bytes(payload)
                headers = {"X-ShareGuard-Demo": "true"} if backend.name == "mock" else None
            except ValueError as exc:
                status, content_type, data = json_bytes(
                    {"error": str(exc)},
                    status=400,
                )
                headers = None
            except Exception as exc:
                print(f"Analysis request failed: {exc}")
                status, content_type, data = json_bytes(
                    {"error": "Analysis service unavailable"},
                    status=503,
                )
                headers = None
            self.send_payload(status, content_type, data, headers)

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
