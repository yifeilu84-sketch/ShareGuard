"""Product-facing analysis boundary for private model inference."""

from dataclasses import dataclass
from io import BytesIO
from threading import BoundedSemaphore
from time import perf_counter
from typing import Any, Dict, Mapping, Optional

from PIL import Image, UnidentifiedImageError

from .config import PlatformConfig
from .product import build_authenticity_report, make_propagation_views


ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
PUBLIC_BACKEND_NAME = "private-model-api"
DISCLAIMER = "本结果为技术辅助，不替代司法鉴定或最终法律结论。"


class AnalysisError(Exception):
    """An analysis failure safe to map to a public API error."""

    def __init__(self, status: int, code: str, public_message: str):
        super().__init__(public_message)
        self.status = int(status)
        self.code = code
        self.public_message = public_message


@dataclass(frozen=True)
class Decision:
    value: str
    label: str
    recommended_action: str
    uncertainty: str


class DecisionPolicy:
    """Translate model risk into a publication workflow decision."""

    def decide(self, payload: Mapping[str, Any]) -> Decision:
        confidence = float(payload.get("confidence", 0.0))
        risk_level = str(payload.get("risk_level", "uncertain"))
        label = str(payload.get("label", "real"))

        uncertainty = "low"
        if confidence < 0.2:
            uncertainty = "high"
        elif confidence < 0.6:
            uncertainty = "medium"

        if confidence < 0.2 or risk_level == "uncertain":
            return Decision(
                value="review",
                label="需要人工复核",
                recommended_action="模型置信度较低，请结合来源信息进行人工复核。",
                uncertainty=uncertainty,
            )
        if risk_level == "high":
            return Decision(
                value="hold",
                label="建议暂缓发布",
                recommended_action="建议暂缓公开使用，进入人工复核或进一步取证流程。",
                uncertainty=uncertainty,
            )
        if risk_level == "medium" or (risk_level == "low" and label == "ai_generated"):
            return Decision(
                value="review",
                label="需要人工复核",
                recommended_action="建议暂缓公开使用，并结合来源信息进行人工复核。",
                uncertainty=uncertainty,
            )
        return Decision(
            value="allow",
            label="可进入发布流程",
            recommended_action="可进入后续发布流程，并保留来源与审核记录。",
            uncertainty=uncertainty,
        )


@dataclass(frozen=True)
class AnalysisOutcome:
    public_payload: Dict[str, Any]
    legacy_payload: Dict[str, Any]


class AnalysisService:
    """Validate media, invoke a private backend once, and sanitize output."""

    def __init__(
        self,
        backend,
        config: PlatformConfig,
        policy: Optional[DecisionPolicy] = None,
    ):
        self.backend = backend
        self.config = config
        self.policy = policy or DecisionPolicy()
        if config.max_inference_concurrency < 1:
            raise ValueError("max_inference_concurrency must be at least 1")
        if config.max_waiting_requests < 0:
            raise ValueError("max_waiting_requests cannot be negative")
        self._admission = BoundedSemaphore(
            config.max_inference_concurrency + config.max_waiting_requests
        )
        self._inference = BoundedSemaphore(config.max_inference_concurrency)

    def warmup(self) -> None:
        warmup = getattr(self.backend, "warmup", None)
        if warmup:
            warmup()

    def is_ready(self) -> bool:
        checker = getattr(self.backend, "is_ready", None)
        return bool(checker()) if checker else True

    def analyze(
        self,
        image_bytes: bytes,
        filename: str,
        request_id: str,
    ) -> AnalysisOutcome:
        started = perf_counter()
        if not self._admission.acquire(blocking=False):
            raise AnalysisError(
                429,
                "service_busy",
                "当前分析请求较多，请稍后重试。",
            )
        try:
            image, image_format = self._decode_image(image_bytes)
            safe_name = _safe_filename(filename)
            return self._analyze_admitted(
                image,
                image_format,
                safe_name,
                request_id,
                started,
            )
        finally:
            self._admission.release()

    def _analyze_admitted(
        self,
        image: Image.Image,
        image_format: str,
        safe_name: str,
        request_id: str,
        started: float,
    ) -> AnalysisOutcome:
        self._inference.acquire()
        try:
            result = self.backend.analyze(image, filename=safe_name).to_dict()
        finally:
            self._inference.release()
        decision = self.policy.decide(result)

        model_version = self.config.model_version
        raw = result.get("raw")
        if isinstance(raw, Mapping) and raw.get("model_version"):
            model_version = str(raw["model_version"])

        safe_result = {
            "file_name": safe_name,
            "label": result.get("label", "real"),
            "probability_ai_generated": float(
                result.get("probability_ai_generated", 0.0)
            ),
            "confidence": float(result.get("confidence", 0.0)),
            "risk_level": result.get("risk_level", "uncertain"),
            "backend": PUBLIC_BACKEND_NAME,
            "image": {
                "width": int(image.width),
                "height": int(image.height),
                "mode": "RGB",
                "format": image_format,
            },
            "evidence": [
                "私有模型服务已完成分析",
                "结果已转换为发布风险决策",
            ],
            "raw": {"model_version": model_version},
        }
        propagation_views = make_propagation_views(image)
        safe_result["propagation_views"] = propagation_views
        report = build_authenticity_report(safe_result)
        report["recommended_action"] = decision.recommended_action
        report["summary"] = decision.recommended_action
        elapsed_ms = max(0, round((perf_counter() - started) * 1000))

        public_payload = {
            "request_id": request_id,
            "model_version": model_version,
            "decision": decision.value,
            "decision_label": decision.label,
            "risk_level": safe_result["risk_level"],
            "ai_probability": safe_result["probability_ai_generated"],
            "confidence": safe_result["confidence"],
            "uncertainty": decision.uncertainty,
            "recommended_action": decision.recommended_action,
            "image": dict(safe_result["image"]),
            "propagation_views": propagation_views,
            "report": report,
            "warnings": [DISCLAIMER],
            "latency_ms": elapsed_ms,
        }
        legacy_payload = {
            **safe_result,
            "request_id": request_id,
            "report": report,
            "decision": decision.value,
            "decision_label": decision.label,
            "uncertainty": decision.uncertainty,
            "recommended_action": decision.recommended_action,
            "warnings": [DISCLAIMER],
            "latency_ms": elapsed_ms,
        }
        return AnalysisOutcome(
            public_payload=public_payload,
            legacy_payload=legacy_payload,
        )

    def _decode_image(self, image_bytes: bytes):
        if not image_bytes:
            raise AnalysisError(400, "missing_image", "请上传需要分析的图片。")
        if len(image_bytes) > self.config.max_upload_bytes:
            raise AnalysisError(
                413,
                "payload_too_large",
                "图片文件超过允许的大小。",
            )

        try:
            source = Image.open(BytesIO(image_bytes))
            image_format = (source.format or "").upper()
            if image_format not in ALLOWED_IMAGE_FORMATS:
                raise AnalysisError(
                    415,
                    "unsupported_image",
                    "请上传 JPEG、PNG 或 WebP 图片。",
                )
            if getattr(source, "is_animated", False) or getattr(source, "n_frames", 1) > 1:
                raise AnalysisError(
                    415,
                    "unsupported_image",
                    "暂不支持动画图片，请上传单帧 JPEG、PNG 或 WebP 图片。",
                )
            if source.width * source.height > self.config.max_image_pixels:
                raise AnalysisError(
                    413,
                    "image_too_large",
                    "图片像素尺寸超过允许范围。",
                )
            image = source.convert("RGB")
            image.load()
        except AnalysisError:
            raise
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise AnalysisError(
                415,
                "unsupported_image",
                "图片无法读取或格式不受支持。",
            ) from exc
        return image, image_format


def _safe_filename(filename: str) -> str:
    normalized = (filename or "upload").replace("\\", "/").replace("\x00", "")
    name = normalized.rsplit("/", 1)[-1].strip() or "upload"
    return name[:255]
