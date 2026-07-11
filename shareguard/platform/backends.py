"""Detection backend adapters for the ShareGuard platform."""

from dataclasses import dataclass, field
from io import BytesIO
import json
from pathlib import Path
import uuid
from urllib import request
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from typing import Any, Callable, Dict, List, Optional, Protocol

from PIL import Image, ImageStat


class DetectorBackend(Protocol):
    """Protocol implemented by all platform detection backends."""

    name: str

    def analyze(self, image: Image.Image, filename: str = "image") -> "DetectionResult":
        """Analyze one image and return a normalized detection result."""

    def warmup(self) -> None:
        """Load inference resources before readiness is advertised."""

    def is_ready(self) -> bool:
        """Return whether the backend can accept inference work."""


@dataclass
class DetectionResult:
    """Normalized platform response for one analyzed image."""

    file_name: str
    label: str
    probability_ai_generated: float
    confidence: float
    risk_level: str
    backend: str
    image: Dict[str, Any]
    evidence: List[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "file_name": self.file_name,
            "label": self.label,
            "probability_ai_generated": float(self.probability_ai_generated),
            "confidence": float(self.confidence),
            "risk_level": self.risk_level,
            "backend": self.backend,
            "image": dict(self.image),
            "evidence": list(self.evidence),
            "raw": dict(self.raw),
        }


def image_info(image: Image.Image) -> Dict[str, Any]:
    return {
        "width": int(image.width),
        "height": int(image.height),
        "mode": image.mode,
    }


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def label_from_probability(probability_ai_generated: float, threshold: float = 0.5) -> str:
    return "ai_generated" if probability_ai_generated >= threshold else "real"


def risk_from_probability(probability_ai_generated: float, confidence: float) -> str:
    if confidence < 0.2:
        return "uncertain"
    if probability_ai_generated >= 0.8:
        return "high"
    if probability_ai_generated >= 0.6:
        return "medium"
    return "low"


class MockDetectorBackend:
    """Deterministic no-checkpoint backend for UI and API smoke tests."""

    name = "mock"

    def warmup(self) -> None:
        return None

    def is_ready(self) -> bool:
        return True

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        rgb = image.convert("RGB")
        gray = rgb.convert("L")
        stat = ImageStat.Stat(gray.resize((64, 64)))
        mean = stat.mean[0] / 255.0
        std = stat.stddev[0] / 128.0
        # A stable, image-dependent demo score. It is intentionally not a detector.
        centered_brightness = 1.0 - abs(mean - 0.5) * 2.0
        prob = clamp01(0.28 + 0.42 * centered_brightness + 0.18 * min(std, 1.0))
        confidence = clamp01(abs(prob - 0.5) * 2.0)
        label = label_from_probability(prob)
        return DetectionResult(
            file_name=filename,
            label=label,
            probability_ai_generated=prob,
            confidence=confidence,
            risk_level=risk_from_probability(prob, confidence),
            backend=self.name,
            image=image_info(rgb),
            evidence=[
                "Demo backend only; no model checkpoint is loaded.",
                "Use --backend shareguard --checkpoint PATH to attach a trained detector.",
            ],
            raw={"demo_mean_luma": mean, "demo_luma_std": std},
        )


class ShareGuardDetectorBackend:
    """Adapter around shareguard.engine.infer.Detector."""

    name = "shareguard"

    def __init__(
        self,
        checkpoint_path: str,
        device: Optional[str] = None,
        detector_factory: Optional[Callable[..., Any]] = None,
    ):
        self.checkpoint_path = str(checkpoint_path)
        self.device = device
        self._detector_factory = detector_factory
        self._detector = None

    def _load_detector(self):
        if self._detector is not None:
            return self._detector
        if self._detector_factory is not None:
            self._detector = self._detector_factory(self.checkpoint_path, self.device)
            return self._detector
        from shareguard.engine.infer import Detector

        path = Path(self.checkpoint_path)
        if not path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {path}")
        self._detector = Detector(str(path), device=self.device)
        return self._detector

    def warmup(self) -> None:
        self._load_detector()

    def is_ready(self) -> bool:
        return self._detector is not None

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        rgb = image.convert("RGB")
        detector = self._load_detector()
        raw = detector.predict(rgb)
        prob = clamp01(raw.get("probability", 0.0))
        confidence = clamp01(raw.get("confidence", abs(prob - 0.5) * 2.0))
        label = label_from_probability(prob)
        if raw.get("prediction") == "real" and prob >= 0.5:
            label = "real"
        elif raw.get("prediction") == "fake":
            label = "ai_generated"

        return DetectionResult(
            file_name=filename,
            label=label,
            probability_ai_generated=prob,
            confidence=confidence,
            risk_level=risk_from_probability(prob, confidence),
            backend=self.name,
            image=image_info(rgb),
            evidence=[
                f"checkpoint: {self.checkpoint_path}",
                "adapter: shareguard.engine.infer.Detector",
            ],
            raw=raw,
        )


class RemoteDetectorBackend:
    """Forward images to an HPC-hosted ShareGuard-compatible API."""

    name = "remote"

    def __init__(
        self,
        endpoint_url: str,
        token: Optional[str] = None,
        timeout: float = 120.0,
        health_url: Optional[str] = None,
    ):
        self.endpoint_url = endpoint_url
        self.token = token
        self.timeout = timeout
        self.health_url = health_url or self._derive_health_url(endpoint_url)
        self._ready = False

    def warmup(self) -> None:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = request.Request(self.health_url, headers=headers, method="GET")
        try:
            with request.urlopen(req, timeout=min(self.timeout, 10.0)) as response:
                body = response.read()
                payload = json.loads(body.decode("utf-8")) if body else {}
            if payload and payload.get("status") not in {"ok", "ready"}:
                raise ValueError("remote detector is not ready")
        except Exception:
            self._ready = False
            raise RuntimeError("Remote detector readiness check failed") from None
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        rgb = image.convert("RGB")
        body, content_type = self._multipart_body(rgb, filename)
        headers = {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = request.Request(
            self.endpoint_url,
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            self._ready = False
            raise RuntimeError(f"Remote detector HTTP {exc.code}") from None
        except (URLError, OSError, ValueError):
            self._ready = False
            raise RuntimeError("Remote detector request failed") from None

        self._ready = True
        return self._result_from_payload(payload, filename, rgb)

    @staticmethod
    def _derive_health_url(endpoint_url: str) -> str:
        parts = urlsplit(endpoint_url)
        path = parts.path.rstrip("/")
        for suffix in ("/api/analyze", "/v1/analyze"):
            if path.endswith(suffix):
                path = path[: -len(suffix)] + "/v1/ready"
                break
        else:
            path += "/v1/ready"
        return urlunsplit((parts.scheme, parts.netloc, path, "", ""))

    def _multipart_body(self, image: Image.Image, filename: str):
        boundary = f"----shareguard-{uuid.uuid4().hex}"
        buf = BytesIO()
        image.save(buf, format="PNG")
        image_bytes = buf.getvalue()
        safe_name = filename or "upload.png"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{safe_name}"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode("utf-8") + image_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
        return body, f"multipart/form-data; boundary={boundary}"

    def _result_from_payload(self, payload: Dict[str, Any], filename: str, image: Image.Image):
        if "probability_ai_generated" in payload:
            prob = clamp01(payload["probability_ai_generated"])
        else:
            prob = clamp01(payload.get("probability", 0.0))
        confidence = clamp01(payload.get("confidence", abs(prob - 0.5) * 2.0))
        label = payload.get("label") or label_from_probability(prob)
        if label == "fake":
            label = "ai_generated"
        remote_backend = payload.get("backend", "unknown")
        evidence = list(payload.get("evidence", []))
        evidence.append(f"remote endpoint: {self.endpoint_url}")
        return DetectionResult(
            file_name=payload.get("file_name", filename),
            label=label,
            probability_ai_generated=prob,
            confidence=confidence,
            risk_level=payload.get("risk_level", risk_from_probability(prob, confidence)),
            backend=f"remote:{remote_backend}",
            image=payload.get("image", image_info(image)),
            evidence=evidence,
            raw=payload.get("raw", payload),
        )
