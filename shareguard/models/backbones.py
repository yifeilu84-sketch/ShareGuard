"""Backbone model wrappers for feature extraction.

Supports CLIP and DINOv2 with frozen weights.
"""

from typing import Optional, Tuple

import torch
import torch.nn as nn


class BackboneWrapper(nn.Module):
    """Generic backbone wrapper that extracts features.

    Args:
        model: The backbone model.
        feat_dim: Output feature dimension.
        pool: Whether to pool spatial features.
    """

    def __init__(self, model: nn.Module, feat_dim: int, pool: bool = True):
        super().__init__()
        self.model = model
        self.feat_dim = feat_dim
        self.pool = pool

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Extract features.

        Args:
            x: Input tensor [B, C, H, W].

        Returns:
            Feature tensor [B, D].
        """
        raise NotImplementedError


class CLIPBackbone(BackboneWrapper):
    """CLIP image encoder wrapper.

    Args:
        model_name: CLIP model name (e.g., 'ViT-B-16', 'ViT-L-14').
        pretrained: Pretrained weights ('openai', 'laion400m', etc.).
    """

    def __init__(
        self,
        model_name: str = "ViT-B-16",
        pretrained: str = "openai",
    ):
        try:
            import open_clip
        except ImportError:
            raise ImportError("open_clip_torch is required. Install with: pip install open_clip_torch")

        model, _, preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self.preprocess = preprocess
        feat_dim = model.visual.output_dim if hasattr(model.visual, "output_dim") else 512

        super().__init__(model.visual, feat_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Extract CLIP visual features.

        Args:
            x: Preprocessed input tensor [B, C, H, W].

        Returns:
            Feature tensor [B, D].
        """
        with torch.no_grad():
            features = self.model(x)
            if isinstance(features, tuple):
                features = features[0]
        return features


class DINOv2Backbone(BackboneWrapper):
    """DINOv2 vision transformer wrapper.

    Args:
        model_name: DINOv2 model name.
            Options: 'dinov2_vits14', 'dinov2_vitb14', 'dinov2_vitl14', 'dinov2_vitg14'
    """

    # DINOv2 feature dimensions
    FEAT_DIMS = {
        "dinov2_vits14": 384,
        "dinov2_vitb14": 768,
        "dinov2_vitl14": 1024,
        "dinov2_vitg14": 1536,
    }

    def __init__(self, model_name: str = "dinov2_vitb14"):
        try:
            import torch.hub
            model = torch.hub.load("facebookresearch/dinov2", model_name)
        except Exception:
            # Fallback: try loading from timm
            try:
                import timm
                model = timm.create_model(model_name, pretrained=True)
            except Exception:
                raise RuntimeError(f"Failed to load DINOv2 model: {model_name}")

        feat_dim = self.FEAT_DIMS.get(model_name, 768)
        super().__init__(model, feat_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Extract DINOv2 features.

        Args:
            x: Preprocessed input tensor [B, C, H, W].

        Returns:
            Feature tensor [B, D].
        """
        with torch.no_grad():
            # DINOv2 returns features from forward_features
            if hasattr(self.model, "forward_features"):
                features = self.model.forward_features(x)
                # Pool spatial features if needed
                if features.dim() > 2 and self.pool:
                    # Use CLS token if available, otherwise mean pool
                    if hasattr(self.model, "cls_token"):
                        features = features[:, 0]  # CLS token
                    else:
                        features = features.mean(dim=1)
            else:
                features = self.model(x)
        return features


class TimmBackbone(BackboneWrapper):
    """Wrapper for timm models.

    Args:
        model_name: Model name in timm registry.
        pretrained: Whether to load pretrained weights.
        num_classes: Set to 0 to get features instead of logits.
    """

    def __init__(self, model_name: str = "resnet50", pretrained: bool = True, num_classes: int = 0):
        try:
            import timm
        except ImportError:
            raise ImportError("timm is required. Install with: pip install timm")

        model = timm.create_model(model_name, pretrained=pretrained, num_classes=num_classes)
        feat_dim = model.num_features if hasattr(model, "num_features") else 2048

        super().__init__(model, feat_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Extract features."""
        with torch.no_grad():
            features = self.model(x)
        return features


def get_backbone(
    name: str,
    pretrained: str = "openai",
    freeze: bool = True,
) -> BackboneWrapper:
    """Get a backbone model by name.

    Args:
        name: Model name. Options:
            - 'clip_vit_b16': CLIP ViT-B/16
            - 'clip_vit_l14': CLIP ViT-L/14
            - 'dinov2_vits14': DINOv2 ViT-S/14
            - 'dinov2_vitb14': DINOv2 ViT-B/14 (default)
            - 'dinov2_vitl14': DINOv2 ViT-L/14
            - Any timm model name
        pretrained: Pretrained weights identifier.
        freeze: Whether to freeze model weights.

    Returns:
        BackboneWrapper instance.
    """
    name_lower = name.lower()

    if name_lower.startswith("clip"):
        if "l14" in name_lower:
            backbone = CLIPBackbone("ViT-L-14", pretrained)
        else:
            backbone = CLIPBackbone("ViT-B-16", pretrained)
    elif name_lower.startswith("dinov2"):
        backbone = DINOv2Backbone(name_lower)
    else:
        backbone = TimmBackbone(name, pretrained=True)

    if freeze:
        for param in backbone.parameters():
            param.requires_grad = False
        backbone.eval()

    return backbone
