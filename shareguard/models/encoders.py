"""Encoder wrappers for ShareGuard.

Supports CLIP, DINOv2, SigLIP with frozen, adapter, or LoRA modes.
"""

from typing import Optional

import torch
import torch.nn as nn


class EncoderWrapper(nn.Module):
    """Generic encoder wrapper.

    Args:
        model: The encoder model.
        feat_dim: Output feature dimension.
        mode: Fine-tuning mode ('frozen', 'adapter', 'lora').
    """

    def __init__(self, model: nn.Module, feat_dim: int, mode: str = "frozen"):
        super().__init__()
        self.model = model
        self.feat_dim = feat_dim
        self.mode = mode

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Extract features.

        Args:
            x: Input tensor [B, C, H, W].

        Returns:
            Feature tensor [B, D].
        """
        raise NotImplementedError


class CLIPEncoder(EncoderWrapper):
    """CLIP image encoder."""

    def __init__(self, model_name: str = "ViT-B-16", pretrained: str = "openai", mode: str = "frozen"):
        try:
            import open_clip
        except ImportError:
            raise ImportError("pip install open_clip_torch")

        model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
        feat_dim = model.visual.output_dim if hasattr(model.visual, "output_dim") else 512
        super().__init__(model.visual, feat_dim, mode)
        self.preprocess = preprocess

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad() if self.mode == "frozen" else torch.enable_grad():
            features = self.model(x)
            if isinstance(features, tuple):
                features = features[0]
        return features


class DINOv2Encoder(EncoderWrapper):
    """DINOv2 vision transformer encoder."""

    FEAT_DIMS = {
        "dinov2_vits14": 384,
        "dinov2_vitb14": 768,
        "dinov2_vitl14": 1024,
        "dinov2_vitg14": 1536,
    }

    def __init__(self, model_name: str = "dinov2_vitb14", mode: str = "frozen"):
        try:
            model = torch.hub.load("facebookresearch/dinov2", model_name)
        except Exception:
            import timm
            model = timm.create_model(model_name, pretrained=True)

        feat_dim = self.FEAT_DIMS.get(model_name, 768)
        super().__init__(model, feat_dim, mode)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad() if self.mode == "frozen" else torch.enable_grad():
            if hasattr(self.model, "forward_features"):
                features = self.model.forward_features(x)
                if features.dim() > 2:
                    features = features[:, 0]  # CLS token
            else:
                features = self.model(x)
        return features


class SigLIPEncoder(EncoderWrapper):
    """SigLIP encoder (from timm)."""

    def __init__(self, model_name: str = "vit_base_patch16_siglip_224", mode: str = "frozen"):
        import timm
        model = timm.create_model(model_name, pretrained=True)
        feat_dim = model.num_features if hasattr(model, "num_features") else 768
        super().__init__(model, feat_dim, mode)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        with torch.no_grad() if self.mode == "frozen" else torch.enable_grad():
            features = self.model(x)
        return features


def get_encoder(
    name: str,
    mode: str = "frozen",
    pretrained: str = "openai",
) -> EncoderWrapper:
    """Get encoder by name.

    Args:
        name: Encoder name.
        mode: 'frozen', 'adapter', or 'lora'.
        pretrained: Pretrained weights identifier.

    Returns:
        EncoderWrapper instance.
    """
    name_lower = name.lower()

    if "clip" in name_lower:
        if "l14" in name_lower:
            return CLIPEncoder("ViT-L-14", pretrained, mode)
        return CLIPEncoder("ViT-B-16", pretrained, mode)

    elif "dinov2" in name_lower:
        return DINOv2Encoder(name_lower, mode)

    elif "siglip" in name_lower:
        return SigLIPEncoder(name_lower.replace("siglip_", ""), mode)

    else:
        import timm
        model = timm.create_model(name, pretrained=True, num_classes=0)
        feat_dim = model.num_features
        return EncoderWrapper(model, feat_dim, mode)
