"""SPAI screening backend and non-authoritative ShareGuard shadow evaluation."""

from dataclasses import replace
import logging
from pathlib import Path
import random
import sys
from typing import Any, Callable, Optional

import numpy as np
from PIL import Image, ImageOps

from .backends import (
    DetectionResult,
    clamp01,
    image_info,
    label_from_probability,
    risk_from_probability,
)


SPAI_ENGINE = "spai-public-v1"
SHAREGUARD_SHADOW_ENGINE = "shareguard-private-v1"
DECISION_LAYER = "shareguard-dossier-v1"


class SpaiDetectorBackend:
    """Run the pinned open-source SPAI checkpoint as the live screening engine."""

    name = SPAI_ENGINE

    def __init__(
        self,
        checkpoint_path: str,
        source_dir: str,
        config_path: Optional[str] = None,
        device: Optional[str] = None,
        threshold: float = 0.5,
        max_dimension: int = 2048,
        source_revision: str = "b1b1422f2912594ba2620b311dde5d28a230d04c",
        predictor_factory: Optional[Callable[..., Any]] = None,
    ):
        if not 0.0 < float(threshold) < 1.0:
            raise ValueError("SPAI threshold must be between 0 and 1")
        if int(max_dimension) < 224:
            raise ValueError("SPAI max dimension must be at least 224")
        self.checkpoint_path = str(checkpoint_path)
        self.source_dir = str(source_dir)
        self.config_path = str(
            config_path or Path(source_dir) / "configs" / "spai.yaml"
        )
        self.device = device
        self.threshold = float(threshold)
        self.max_dimension = int(max_dimension)
        self.source_revision = str(source_revision)
        self._predictor_factory = predictor_factory
        self._predictor = None

    def _load_predictor(self):
        if self._predictor is not None:
            return self._predictor
        factory = self._predictor_factory or _SpaiPredictor
        self._predictor = factory(
            checkpoint_path=self.checkpoint_path,
            source_dir=self.source_dir,
            config_path=self.config_path,
            device=self.device,
            max_dimension=self.max_dimension,
        )
        return self._predictor

    def warmup(self) -> None:
        self._load_predictor()

    def is_ready(self) -> bool:
        return self._predictor is not None

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        rgb = image.convert("RGB")
        score = clamp01(self._load_predictor().predict(rgb))
        confidence = clamp01(abs(score - self.threshold) * 2.0)
        label = label_from_probability(score, threshold=self.threshold)
        return DetectionResult(
            file_name=filename,
            label=label,
            probability_ai_generated=score,
            confidence=confidence,
            risk_level=risk_from_probability(score, confidence),
            backend=self.name,
            image=image_info(rgb),
            evidence=[
                "SPAI image-level spectral screening completed.",
                "ShareGuard publication policy translated the model score into a workflow action.",
            ],
            raw={
                "model_version": SPAI_ENGINE,
                "detector_engine": SPAI_ENGINE,
                "engine_role": "public_fallback",
                "decision_layer": DECISION_LAYER,
                "source_license": "Apache-2.0",
                "source_revision": self.source_revision,
                "localization_available": False,
            },
        )


class HybridDetectorBackend:
    """Return public SPAI output while sampling private-model shadow comparisons."""

    def __init__(
        self,
        primary,
        shadow=None,
        shadow_sample_rate: float = 0.0,
        sampler: Optional[Callable[[], float]] = None,
    ):
        sample_rate = float(shadow_sample_rate)
        if not 0.0 <= sample_rate <= 1.0:
            raise ValueError("shadow sample rate must be between 0 and 1")
        self.primary = primary
        self.shadow = shadow
        self.shadow_sample_rate = sample_rate
        self._sampler = sampler or random.random
        self._shadow_warmup_failed = False
        self.name = primary.name

    def warmup(self) -> None:
        self.primary.warmup()
        if self.shadow is None or self.shadow_sample_rate <= 0.0:
            return
        try:
            self.shadow.warmup()
        except Exception:
            logging.exception("ShareGuard shadow backend warmup failed")
            self._shadow_warmup_failed = True

    def is_ready(self) -> bool:
        return bool(self.primary.is_ready())

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        primary_result = self.primary.analyze(image, filename=filename)
        shadow_metadata = self._evaluate_shadow(primary_result, image, filename)
        raw = dict(primary_result.raw)
        raw["shadow_evaluation"] = shadow_metadata
        return replace(primary_result, raw=raw)

    def _evaluate_shadow(
        self,
        primary_result: DetectionResult,
        image: Image.Image,
        filename: str,
    ) -> dict[str, Any]:
        metadata = {
            "performed": False,
            "status": "not_sampled",
            "engine": SHAREGUARD_SHADOW_ENGINE,
            "affects_decision": False,
        }
        if self.shadow is None or self.shadow_sample_rate <= 0.0:
            metadata["status"] = "disabled"
            return metadata
        if self._sampler() >= self.shadow_sample_rate:
            return metadata
        metadata["performed"] = True
        if self._shadow_warmup_failed:
            metadata["status"] = "unavailable"
            return metadata
        try:
            shadow_result = self.shadow.analyze(image, filename=filename)
        except Exception:
            logging.exception("ShareGuard shadow inference failed")
            metadata["status"] = "unavailable"
            return metadata
        metadata["status"] = (
            "agree" if shadow_result.label == primary_result.label else "disagree"
        )
        return metadata


class _SpaiPredictor:
    """Minimal resident SPAI runtime using the official architecture and preprocessing."""

    def __init__(
        self,
        checkpoint_path: str,
        source_dir: str,
        config_path: str,
        device: Optional[str],
        max_dimension: int,
    ):
        checkpoint = Path(checkpoint_path).expanduser().resolve()
        source = Path(source_dir).expanduser().resolve()
        config_file = Path(config_path).expanduser().resolve()
        if not checkpoint.is_file():
            raise FileNotFoundError(f"SPAI checkpoint not found: {checkpoint}")
        if not (source / "spai" / "models").is_dir():
            raise FileNotFoundError(f"SPAI source directory is invalid: {source}")
        if not config_file.is_file():
            raise FileNotFoundError(f"SPAI config not found: {config_file}")

        source_text = str(source)
        if source_text not in sys.path:
            sys.path.insert(0, source_text)

        import torch
        from safetensors.torch import load_file
        from spai.config import get_config
        from spai.models import build_cls_model

        self.torch = torch
        self.device = torch.device(
            device or ("cuda" if torch.cuda.is_available() else "cpu")
        )
        if self.device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("SPAI CUDA inference requested but CUDA is unavailable")
        self.max_dimension = int(max_dimension)
        self.config = get_config({
            "cfg": str(config_file),
            "batch_size": 1,
            "pretrained": str(checkpoint),
        })
        model = build_cls_model(self.config)
        if checkpoint.suffix != ".safetensors":
            raise ValueError("SPAI production checkpoint must use safetensors")
        state = load_file(str(checkpoint), device="cpu")
        if any(key.startswith("encoder.") for key in state):
            state = {
                key.removeprefix("encoder."): value
                for key, value in state.items()
                if key.startswith("encoder.")
            }
        model_state = model.state_dict()
        compatible = {
            key: value
            for key, value in state.items()
            if key in model_state and tuple(value.shape) == tuple(model_state[key].shape)
        }
        if len(compatible) < int(len(model_state) * 0.95):
            raise ValueError("SPAI checkpoint is incompatible with the pinned architecture")
        model.load_state_dict(compatible, strict=False)
        self.model = model.to(self.device).eval()
        del state, compatible

    def predict(self, image: Image.Image) -> float:
        prepared = self._prepare_image(image)
        array = np.asarray(prepared, dtype=np.float32) / 255.0
        tensor = (
            self.torch.from_numpy(array)
            .permute(2, 0, 1)
            .contiguous()
            .unsqueeze(0)
            .to(self.device)
        )
        with self.torch.inference_mode():
            logits = self.model(
                [tensor],
                self.config.MODEL.FEATURE_EXTRACTION_BATCH,
            )
            score = self.torch.sigmoid(logits).reshape(-1)[0].item()
        return float(score)

    def _prepare_image(self, image: Image.Image) -> Image.Image:
        prepared = image.convert("RGB")
        if max(prepared.size) > self.max_dimension:
            prepared.thumbnail(
                (self.max_dimension, self.max_dimension),
                Image.Resampling.LANCZOS,
            )
        pad_width = max(224 - prepared.width, 0)
        pad_height = max(224 - prepared.height, 0)
        if pad_width or pad_height:
            left = pad_width // 2
            top = pad_height // 2
            prepared = ImageOps.expand(
                prepared,
                border=(left, top, pad_width - left, pad_height - top),
                fill=0,
            )
        return prepared
