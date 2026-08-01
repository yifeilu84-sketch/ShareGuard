"""NoisyShare-Fusion serving backend.

The final competition model is a bundle rather than a single checkpoint:
CLIP-B feature-fusion ensemble + CLIP-L feature-fusion ensemble + dev-selected
score fusion parameters.
"""

import json
from io import BytesIO
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from PIL import Image

from .backends import DetectionResult, clamp01, image_info, label_from_probability, risk_from_probability
from .safe_checkpoints import load_safe_checkpoint


SPATIAL_RECHECK_TRIGGER = 0.98
SPATIAL_RECHECK_MIN_GAP = 0.50


def load_bundle_manifest(bundle_dir: str | Path) -> Dict[str, Any]:
    root = Path(bundle_dir)
    path = root / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing bundle manifest: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("bundle_type") != "noisyshare_fusion":
        raise ValueError(f"Unsupported bundle_type: {manifest.get('bundle_type')}")
    for key in ["method", "alpha_clip_l", "threshold", "groups"]:
        if key not in manifest:
            raise ValueError(f"Missing manifest key: {key}")
    if manifest.get("checkpoint_format") != "safetensors":
        raise ValueError("Serving bundle must use safetensors checkpoints")
    return manifest


class NoisyShareFusionBundleBackend:
    """Platform backend for exported NoisyShare-Fusion bundles."""

    name = "noisyshare-fusion"

    def __init__(
        self,
        bundle_dir: str,
        device: Optional[str] = None,
        predictor_factory: Optional[Callable[..., Any]] = None,
    ):
        self.bundle_dir = Path(bundle_dir)
        self.device = device
        self.manifest = load_bundle_manifest(self.bundle_dir)
        self._predictor_factory = predictor_factory
        self._predictor = None
        self._ready = False

    def _load_predictor(self):
        if self._predictor is not None:
            return self._predictor
        if self._predictor_factory is not None:
            self._predictor = self._predictor_factory(self.manifest, self.bundle_dir, self.device)
            return self._predictor
        self._predictor = FeatureFusionEnsemblePredictor(self.manifest, self.bundle_dir, self.device)
        return self._predictor

    def warmup(self) -> None:
        if self._ready:
            return
        predictor = self._load_predictor()
        loader = getattr(predictor, "_load", None) or getattr(predictor, "load", None)
        if loader:
            loader()
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def analyze(self, image: Image.Image, filename: str = "image") -> DetectionResult:
        rgb = image.convert("RGB")
        predictor = self._load_predictor()
        payload = predictor.predict(rgb)
        self._ready = True
        prob = clamp01(payload.get("probability_ai_generated", payload.get("probability", 0.0)))
        confidence = clamp01(payload.get("confidence", abs(prob - 0.5) * 2.0))
        label = payload.get("label", label_from_probability(prob, self.manifest["threshold"]))
        if label == "fake":
            label = "ai_generated"
        spatial_recheck_performed = False
        selective_review = False
        reliability_reason = "secondary_check_not_required"
        if prob >= SPATIAL_RECHECK_TRIGGER:
            spatial_recheck_performed = True
            threshold = float(self.manifest["threshold"])
            crop_scores = [
                clamp01(
                    predictor.predict(crop).get(
                        "probability_ai_generated",
                        0.0,
                    )
                )
                for crop in _spatial_recheck_crops(rgb)
            ]
            minimum_crop_score = min(crop_scores, default=prob)
            selective_review = (
                minimum_crop_score < threshold
                and prob - minimum_crop_score >= SPATIAL_RECHECK_MIN_GAP
            )
            reliability_reason = (
                "spatial_score_inconsistency"
                if selective_review
                else "spatial_recheck_consistent"
            )
        return DetectionResult(
            file_name=filename,
            label=label,
            probability_ai_generated=prob,
            confidence=confidence,
            risk_level=payload.get("risk_level", risk_from_probability(prob, confidence)),
            backend=self.name,
            image=image_info(rgb),
            evidence=[
                "私有模型服务：NoisyShare-Fusion 已接入",
                f"method: {self.manifest['method']}",
                "内部权重、阈值和融合参数不在公开响应中返回",
            ],
            raw={
                "model_version": self.manifest.get("model_version", "shareguard-private-v1"),
                "serving_mode": "private-fusion-bundle",
                "spatial_recheck_performed": spatial_recheck_performed,
                "selective_review": selective_review,
                "reliability_reason": reliability_reason,
            },
        )


def _spatial_recheck_crops(image: Image.Image):
    """Return overlapping upper/lower views for conservative score stability checks."""

    width, height = image.size
    if width < 2 or height < 4:
        return [image]
    midpoint = height // 2
    overlap = max(1, round(height * 0.04))
    upper = image.crop((0, 0, width, min(height, midpoint + overlap)))
    lower = image.crop((0, max(0, midpoint - overlap), width, height))
    return [upper, lower]


class FeatureFusionEnsemblePredictor:
    """Heavy predictor for exported CLIP-B/L feature-fusion ensemble bundles."""

    def __init__(self, manifest: Dict[str, Any], bundle_dir: Path, device: Optional[str] = None):
        self.manifest = manifest
        self.bundle_dir = bundle_dir
        self.device_name = device
        self._loaded = False

    def _load(self):
        if self._loaded:
            return
        import numpy as np
        import torch
        import torch.nn as nn
        import timm
        from torchvision import transforms
        from PIL import ImageFilter

        self.np = np
        self.torch = torch
        self.nn = nn
        self.timm = timm
        self.transforms = transforms
        self.ImageFilter = ImageFilter
        self.device = torch.device(self.device_name or ("cuda" if torch.cuda.is_available() else "cpu"))

        self.dino_name = self.manifest.get("dino_model", "vit_base_patch14_dinov2.lvd142m")
        self.dino = timm.create_model(self.dino_name, pretrained=True, num_classes=0)
        self.dino = self.dino.to(self.device).eval()

        self.dino_transform = transforms.Compose([
            transforms.Resize(518),
            transforms.CenterCrop(518),
            transforms.ToTensor(),
            transforms.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
        ])
        self.clip_transforms = {}
        self.clip_models = {}
        self.groups = {}

        for group_name, entries in self.manifest["groups"].items():
            if not entries:
                continue
            clip_model = entries[0].get("clip_model", "vit_base_patch16_clip_224.openai")
            clip_size = int(entries[0].get("clip_image_size", 224))
            self.clip_models[group_name] = timm.create_model(clip_model, pretrained=True, num_classes=0)
            self.clip_models[group_name] = self.clip_models[group_name].to(self.device).eval()
            self.clip_transforms[group_name] = transforms.Compose([
                transforms.Resize(clip_size, interpolation=transforms.InterpolationMode.BICUBIC),
                transforms.CenterCrop(clip_size),
                transforms.ToTensor(),
                transforms.Normalize(
                    mean=(0.48145466, 0.4578275, 0.40821073),
                    std=(0.26862954, 0.26130258, 0.27577711),
                ),
            ])
            self.groups[group_name] = [self._load_seed_model(entry) for entry in entries]

        self._loaded = True

    def _mlp(self, dim: int):
        return self.nn.Sequential(
            self.nn.Linear(dim, 768),
            self.nn.ReLU(inplace=True),
            self.nn.Dropout(0.25),
            self.nn.Linear(768, 256),
            self.nn.ReLU(inplace=True),
            self.nn.Dropout(0.15),
            self.nn.Linear(256, 1),
        )

    def _load_seed_model(self, entry):
        root = self.bundle_dir.resolve()
        path = (self.bundle_dir / entry["checkpoint"]).resolve()
        if root not in path.parents:
            raise ValueError("Checkpoint path escapes the model bundle")
        tensors = load_safe_checkpoint(path, entry.get("checkpoint_sha256", ""))
        mu = tensors["mu"].to(device=self.device, dtype=self.torch.float32)
        sd = tensors["sd"].to(device=self.device, dtype=self.torch.float32)
        dim = int(mu.shape[-1])
        clf = self._mlp(dim).to(self.device)
        state = {
            key[len("classifier."):]: value
            for key, value in tensors.items()
            if key.startswith("classifier.")
        }
        clf.load_state_dict(state, strict=True)
        clf.eval()
        return {"entry": entry, "classifier": clf, "mu": mu, "sd": sd}

    def predict(self, image: Image.Image) -> Dict[str, Any]:
        self._load()
        rgb = image.convert("RGB")
        dino = self._dino_features(rgb)
        freq = self._freq_features(rgb)
        group_scores = {}
        for group_name, models in self.groups.items():
            clip = self._clip_features(group_name, rgb)
            x = self.torch.cat([clip, dino, freq], dim=1)
            scores = []
            for item in models:
                xn = (x - item["mu"]) / item["sd"]
                with self.torch.no_grad():
                    score = self.torch.sigmoid(item["classifier"](xn)).item()
                scores.append(float(score))
            group_scores[group_name] = sum(scores) / max(len(scores), 1)

        alpha = float(self.manifest["alpha_clip_l"])
        clip_l = group_scores.get("clip_l", group_scores.get("clip_b", 0.0))
        clip_b = group_scores.get("clip_b", clip_l)
        fused = alpha * clip_l + (1.0 - alpha) * clip_b
        threshold = float(self.manifest["threshold"])
        confidence = abs(fused - threshold) / max(threshold, 1.0 - threshold, 1e-6)
        return {
            "probability_ai_generated": fused,
            "confidence": clamp01(confidence),
            "label": "ai_generated" if fused >= threshold else "real",
            "risk_level": risk_from_probability(fused, clamp01(confidence)),
            "raw": {
                "group_scores": group_scores,
                "threshold": threshold,
                "alpha_clip_l": alpha,
            },
        }

    def _dino_features(self, image: Image.Image):
        with self.torch.no_grad():
            x = self.dino_transform(image).unsqueeze(0).to(self.device)
            y = self.dino(x)
            if isinstance(y, (tuple, list)):
                y = y[0]
            return y.float()

    def _clip_features(self, group_name: str, image: Image.Image):
        with self.torch.no_grad():
            x = self.clip_transforms[group_name](image).unsqueeze(0).to(self.device)
            y = self.clip_models[group_name](x)
            if isinstance(y, (tuple, list)):
                y = y[0]
            return y.float()

    def _freq_features(self, image: Image.Image):
        gray_img = image.convert("L").resize((256, 256), Image.BILINEAR)
        gray = self.np.asarray(gray_img).astype(self.np.float32) / 255.0
        centered = gray - gray.mean()
        mag = self.np.log1p(self.np.abs(self.np.fft.fftshift(self.np.fft.fft2(centered))))
        h, w = mag.shape
        yy, xx = self.np.indices((h, w))
        rr = self.np.sqrt((yy - h / 2) ** 2 + (xx - w / 2) ** 2)
        rr = rr / rr.max()
        bins = []
        edges = self.np.linspace(0, 1, 17)
        for lo, hi in zip(edges[:-1], edges[1:]):
            vals = mag[(rr >= lo) & (rr < hi)]
            bins.append(vals.mean() if vals.size else 0.0)

        blur = self.np.asarray(gray_img.filter(self.ImageFilter.GaussianBlur(radius=2))).astype(self.np.float32) / 255.0
        hp = gray - blur
        gx = self.np.diff(gray, axis=1)
        gy = self.np.diff(gray, axis=0)
        buf = BytesIO()
        image.resize((256, 256), Image.BILINEAR).save(buf, format="JPEG", quality=75)
        buf.seek(0)
        jpg = self.np.asarray(Image.open(buf).convert("L")).astype(self.np.float32) / 255.0
        diff = self.np.abs(gray - jpg)
        stats = [
            hp.mean(), hp.std(), self.np.mean(self.np.abs(hp)), self.np.percentile(self.np.abs(hp), 90),
            gx.std(), gy.std(), self.np.mean(self.np.abs(gx)), self.np.mean(self.np.abs(gy)),
            diff.mean(), diff.std(), self.np.percentile(diff, 90), self.np.percentile(diff, 99),
        ]
        arr = self.np.asarray(bins + stats, dtype=self.np.float32)
        return self.torch.from_numpy(arr).unsqueeze(0).to(self.device)
