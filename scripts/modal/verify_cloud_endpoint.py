"""Verify a deployed ShareGuard inference endpoint without exposing secrets."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter, time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


PUBLIC_ORIGIN = "https://shareguard.systems"
PRIVATE_RESPONSE_KEYS = {
    "alpha_clip_l",
    "group_scores",
    "checkpoint",
    "model_artifacts",
    "raw",
}


@dataclass(frozen=True)
class VerificationResult:
    ready_latency_ms: int
    inference_latency_ms: int
    model_version: str
    decision: str


def _normalized_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    loopback_http = parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "::1",
        "localhost",
    }
    if parsed.scheme != "https" and not loopback_http:
        raise ValueError("endpoint must use HTTPS")
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("endpoint must be an origin without embedded credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("endpoint must not include a path, query, or fragment")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _basic_authorization(username: str, password: str) -> str:
    encoded = base64.b64encode(
        f"{username}:{password}".encode("utf-8")
    ).decode("ascii")
    return f"Basic {encoded}"


def _request_json(
    request: Request,
    *,
    expected_status: int,
    timeout_seconds: int = 180,
) -> tuple[dict[str, Any], int]:
    started = perf_counter()
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status = response.status
            body = response.read()
    except HTTPError as exc:
        status = exc.code
        body = exc.read()
    except URLError as exc:
        raise RuntimeError("ShareGuard endpoint is unavailable") from exc
    latency_ms = max(0, round((perf_counter() - started) * 1000))

    if status != expected_status:
        raise RuntimeError(
            f"unexpected HTTP status: expected {expected_status}, received {status}"
        )
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("endpoint returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("endpoint response must be a JSON object")
    return payload, latency_ms


def _assert_public_response(value: Any, path: str = "response") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).strip().lower()
            if normalized in PRIVATE_RESPONSE_KEYS:
                raise ValueError(f"private response field detected at {path}.{key}")
            _assert_public_response(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_public_response(child, f"{path}[{index}]")


def _edge_headers(edge_secret: str, method: str, path: str) -> dict[str, str]:
    client_id = hmac.new(
        edge_secret.encode("utf-8"),
        b"shareguard-cloud-verifier",
        hashlib.sha256,
    ).hexdigest()
    timestamp = str(int(time()))
    canonical = "\n".join([timestamp, method.upper(), path, client_id])
    signature = hmac.new(
        edge_secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-ShareGuard-Client-Id": client_id,
        "X-ShareGuard-Edge-Timestamp": timestamp,
        "X-ShareGuard-Edge-Signature": signature,
    }


def verify_endpoint(
    base_url: str,
    username: str,
    password: str,
    image_path: Path,
    *,
    edge_secret: str | None = None,
) -> VerificationResult:
    """Verify authentication, readiness, inference, and response privacy."""

    base_url = _normalized_base_url(base_url)
    image_path = Path(image_path)
    if not username or not password:
        raise ValueError("HTTP Basic credentials are required")
    if not image_path.is_file():
        raise FileNotFoundError(image_path)

    common_headers = {
        "Origin": PUBLIC_ORIGIN,
        "User-Agent": "ShareGuard-Cloud-Verifier/1.0",
    }
    ready_edge_headers = (
        _edge_headers(edge_secret, "GET", "/v1/ready")
        if edge_secret
        else {}
    )
    unauthenticated = Request(
        f"{base_url}/v1/ready",
        headers={**common_headers, **ready_edge_headers},
        method="GET",
    )
    _request_json(unauthenticated, expected_status=401)

    authenticated_headers = {
        **common_headers,
        **ready_edge_headers,
        "Authorization": _basic_authorization(username, password),
    }
    ready_payload, ready_latency_ms = _request_json(
        Request(
            f"{base_url}/v1/ready",
            headers=authenticated_headers,
            method="GET",
        ),
        expected_status=200,
    )
    _assert_public_response(ready_payload)
    if ready_payload.get("status") != "ready":
        raise RuntimeError("endpoint did not report ready status")

    image_bytes = image_path.read_bytes()
    content_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    analyze_payload, inference_latency_ms = _request_json(
        Request(
            f"{base_url}/v1/analyze",
            data=image_bytes,
            headers={
                **authenticated_headers,
                **(
                    _edge_headers(edge_secret, "POST", "/v1/analyze")
                    if edge_secret
                    else {}
                ),
                "Content-Type": content_type,
                "X-File-Name": image_path.name,
            },
            method="POST",
        ),
        expected_status=200,
    )
    _assert_public_response(analyze_payload)

    model_version = str(analyze_payload.get("model_version") or "")
    decision = str(analyze_payload.get("decision") or "")
    if not model_version or not decision:
        raise ValueError("inference response is missing public result fields")
    if ready_payload.get("model_version") not in {None, model_version}:
        raise ValueError("readiness and inference model versions do not match")

    return VerificationResult(
        ready_latency_ms=ready_latency_ms,
        inference_latency_ms=inference_latency_ms,
        model_version=model_version,
        decision=decision,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify a private ShareGuard cloud inference endpoint."
    )
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument(
        "--direct-origin",
        action="store_true",
        help="add the private edge identity required by the direct Modal origin",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    username = os.environ.get("SHAREGUARD_HTTP_BASIC_USERNAME", "")
    password = os.environ.get("SHAREGUARD_HTTP_BASIC_PASSWORD", "")
    if not username or not password:
        raise SystemExit(
            "SHAREGUARD_HTTP_BASIC_USERNAME and "
            "SHAREGUARD_HTTP_BASIC_PASSWORD must be set"
        )
    edge_secret = ""
    if args.direct_origin:
        edge_secret = os.environ.get("SHAREGUARD_EDGE_SHARED_SECRET", "")
        if not edge_secret:
            raise SystemExit(
                "SHAREGUARD_EDGE_SHARED_SECRET must be set for --direct-origin"
            )
    result = verify_endpoint(
        args.base_url,
        username,
        password,
        args.image,
        edge_secret=edge_secret or None,
    )
    print(json.dumps(asdict(result), ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
