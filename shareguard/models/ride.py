"""RIDE: Robust Inference via Degradation Ensemble.

Core model combining multi-view semantic features, frequency domain features,
and consistency training for robust AI-generated image detection.
"""

from typing import Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .backbones import BackboneWrapper, get_backbone
from .frequency_branch import FrequencyBranch, extract_frequency_features_batch


class RIDE(nn.Module):
    """RIDE model for robust AI-generated image detection.

    Architecture:
        1. Multi-view input processing (K views per image)
        2. Frozen semantic encoder (DINOv2/CLIP)
        3. Multi-view aggregation (mean, std, max)
        4. Frequency domain branch (radial FFT)
        5. Fusion classifier (MLP)

    Args:
        backbone: Backbone model name or BackboneWrapper instance.
        feat_dim: Feature dimension of the backbone.
        freq_dim: Dimension of frequency features (radial bins).
        freq_hidden: Hidden dim for frequency branch.
        hidden_dim: Hidden dim for fusion classifier.
        dropout: Dropout rate.
        num_classes: Number of output classes (1 for binary with BCE).
        use_freq: Whether to use frequency branch.
        use_std: Whether to use std aggregation (key for robustness).
    """

    def __init__(
        self,
        backbone: str = "dinov2_vitb14",
        feat_dim: int = 768,
        freq_dim: int = 128,
        freq_hidden: int = 128,
        hidden_dim: int = 512,
        dropout: float = 0.2,
        num_classes: int = 1,
        use_freq: bool = True,
        use_std: bool = True,
    ):
        super().__init__()
        self.use_freq = use_freq
        self.use_std = use_std
        self.feat_dim = feat_dim

        # Semantic backbone (frozen)
        if isinstance(backbone, str):
            self.backbone = get_backbone(backbone, freeze=True)
        else:
            self.backbone = backbone

        # Frequency branch
        if use_freq:
            self.freq_branch = FrequencyBranch(
                freq_dim=freq_dim,
                hidden_dim=freq_hidden,
                output_dim=freq_hidden,
                dropout=dropout,
            )
            fusion_dim = feat_dim * (3 if use_std else 2) + freq_hidden
        else:
            self.freq_branch = None
            fusion_dim = feat_dim * (3 if use_std else 2)

        # Fusion classifier
        self.classifier = nn.Sequential(
            nn.Linear(fusion_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Dropout(dropout * 0.5),
            nn.Linear(hidden_dim // 2, num_classes),
        )

    def extract_semantic_features(self, views: torch.Tensor) -> torch.Tensor:
        """Extract features from multiple views.

        Args:
            views: Input tensor [B, K, C, H, W].

        Returns:
            Aggregated features [B, feat_dim * agg_dims].
        """
        B, K, C, H, W = views.shape

        # Reshape to [B*K, C, H, W]
        x = views.reshape(B * K, C, H, W)

        # Extract features
        z = self.backbone(x)  # [B*K, D]

        # Reshape back to [B, K, D]
        z = z.reshape(B, K, -1)

        # Aggregate
        z_mean = z.mean(dim=1)  # [B, D]

        parts = [z_mean]

        if self.use_std:
            z_std = z.std(dim=1)  # [B, D]
            parts.append(z_std)

        z_max = z.max(dim=1).values  # [B, D]
        parts.append(z_max)

        return torch.cat(parts, dim=1)

    def forward(
        self,
        views: torch.Tensor,
        freq_feat: Optional[torch.Tensor] = None,
        images: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Forward pass.

        Args:
            views: Multi-view input [B, K, C, H, W].
            freq_feat: Pre-computed frequency features [B, freq_dim].
                If None and use_freq=True, computed from images.
            images: Original images [B, C, H, W] for frequency extraction.

        Returns:
            Logits [B, num_classes].
        """
        # Extract semantic features
        z_agg = self.extract_semantic_features(views)

        # Extract frequency features
        if self.use_freq:
            if freq_feat is None:
                if images is None:
                    # Use first view as fallback
                    images = views[:, 0]
                freq_feat = extract_frequency_features_batch(images)
            f_freq = self.freq_branch(freq_feat)
            h = torch.cat([z_agg, f_freq], dim=1)
        else:
            h = z_agg

        # Classify
        logit = self.classifier(h)
        return logit

    def predict(
        self,
        views: torch.Tensor,
        freq_feat: Optional[torch.Tensor] = None,
        images: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """Predict with probabilities.

        Returns:
            Tuple of (logits, probabilities).
        """
        logit = self.forward(views, freq_feat, images)
        prob = torch.sigmoid(logit)
        return logit, prob

    def get_view_predictions(
        self,
        views: torch.Tensor,
    ) -> torch.Tensor:
        """Get predictions for each individual view (for consistency loss).

        Args:
            views: Multi-view input [B, K, C, H, W].

        Returns:
            Per-view logits [B, K, num_classes].
        """
        B, K, C, H, W = views.shape
        x = views.reshape(B * K, C, H, W)
        z = self.backbone(x)  # [B*K, D]
        z = z.reshape(B * K, -1)

        # Use mean aggregation per view (single view = identity)
        # For single view, mean = the feature itself
        logit = self.classifier(z)  # [B*K, 1]
        logit = logit.reshape(B, K, -1)  # [B, K, 1]

        return logit


class RIDESimple(nn.Module):
    """Simplified RIDE without frequency branch (for ablation).

    Args:
        backbone: Backbone model name.
        feat_dim: Feature dimension.
        hidden_dim: Hidden dimension.
        dropout: Dropout rate.
    """

    def __init__(
        self,
        backbone: str = "dinov2_vitb14",
        feat_dim: int = 768,
        hidden_dim: int = 512,
        dropout: float = 0.2,
    ):
        super().__init__()

        if isinstance(backbone, str):
            self.backbone = get_backbone(backbone, freeze=True)
        else:
            self.backbone = backbone

        # Multi-view aggregation: mean + std + max
        fusion_dim = feat_dim * 3

        self.classifier = nn.Sequential(
            nn.Linear(fusion_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Linear(hidden_dim // 2, 1),
        )

    def forward(self, views: torch.Tensor, **kwargs) -> torch.Tensor:
        B, K, C, H, W = views.shape
        x = views.reshape(B * K, C, H, W)

        with torch.no_grad():
            z = self.backbone(x)

        z = z.reshape(B, K, -1)
        z_mean = z.mean(dim=1)
        z_std = z.std(dim=1)
        z_max = z.max(dim=1).values

        h = torch.cat([z_mean, z_std, z_max], dim=1)
        return self.classifier(h)
