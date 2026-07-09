"""ShareGuard: Degradation-Invariant and Uncertainty-Aware Detection.

Core model combining:
1. Multi-view sharing simulation
2. Semantic encoder (frozen/adapter/LoRA)
3. Frequency domain branch
4. Generator-debias adversarial head
5. Uncertainty-aware classifier
"""

from typing import Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .encoders import get_encoder, EncoderWrapper
from .frequency_branch import FrequencyBranch, extract_frequency_features_batch
from .uncertainty import UncertaintyHead, uncertainty_from_views


class ShareGuard(nn.Module):
    """ShareGuard model for robust AI-generated image detection.

    Args:
        encoder_name: Encoder model name.
        encoder_mode: Fine-tuning mode ('frozen', 'adapter', 'lora').
        feat_dim: Encoder feature dimension.
        freq_dim: Frequency feature dimension.
        hidden_dim: Classifier hidden dimension.
        dropout: Dropout rate.
        use_freq: Whether to use frequency branch.
        use_std: Whether to use std aggregation.
        num_generators: Number of generators for debias head (0 to disable).
        uncertainty_mode: 'learned' (dedicated head) or 'view_variance'.
    """

    def __init__(
        self,
        encoder_name: str = "dinov2_vitb14",
        encoder_mode: str = "frozen",
        feat_dim: int = 768,
        freq_dim: int = 128,
        hidden_dim: int = 512,
        dropout: float = 0.2,
        use_freq: bool = True,
        use_std: bool = True,
        num_generators: int = 0,
        uncertainty_mode: str = "view_variance",
    ):
        super().__init__()
        self.use_freq = use_freq
        self.use_std = use_std
        self.uncertainty_mode = uncertainty_mode
        self.feat_dim = feat_dim

        # Encoder
        self.encoder = get_encoder(encoder_name, mode=encoder_mode)

        # Frequency branch
        if use_freq:
            self.freq_branch = FrequencyBranch(
                freq_dim=freq_dim,
                hidden_dim=128,
                output_dim=128,
                dropout=dropout,
            )
            fusion_dim = feat_dim * (3 if use_std else 2) + 128
        else:
            self.freq_branch = None
            fusion_dim = feat_dim * (3 if use_std else 2)

        # Main classifier
        self.classifier = nn.Sequential(
            nn.Linear(fusion_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Dropout(dropout * 0.5),
            nn.Linear(hidden_dim // 2, 1),
        )

        # Generator debias head (adversarial)
        if num_generators > 0:
            self.gen_classifier = nn.Sequential(
                nn.Linear(feat_dim, hidden_dim // 2),
                nn.GELU(),
                nn.Linear(hidden_dim // 2, num_generators),
            )
        else:
            self.gen_classifier = None

        # Learned uncertainty head
        if uncertainty_mode == "learned":
            self.uncertainty_head = UncertaintyHead(fusion_dim, hidden_dim, dropout)
        else:
            self.uncertainty_head = None

    def extract_features(
        self,
        views: torch.Tensor,
        images: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, Optional[torch.Tensor], Optional[torch.Tensor]]:
        """Extract all features from multi-view input.

        Args:
            views: Multi-view input [B, K, C, H, W].
            images: Original images for frequency extraction.

        Returns:
            Tuple of (aggregated semantic features, frequency features, per-view features).
        """
        B, K, C, H, W = views.shape

        # Reshape for encoder
        x = views.reshape(B * K, C, H, W)
        z = self.encoder(x)  # [B*K, D]
        z = z.reshape(B, K, -1)  # [B, K, D]

        # Per-view features for generator debias
        z_flat = z.reshape(B * K, -1)  # [B*K, D]

        # Aggregation
        z_mean = z.mean(dim=1)  # [B, D]
        parts = [z_mean]

        if self.use_std:
            z_std = z.std(dim=1)  # [B, D]
            parts.append(z_std)

        z_max = z.max(dim=1).values  # [B, D]
        parts.append(z_max)

        z_agg = torch.cat(parts, dim=1)  # [B, D*agg]

        # Frequency features
        f_freq = None
        if self.use_freq:
            if images is None:
                images = views[:, 0]  # Use first view
            freq_feat = extract_frequency_features_batch(images)
            f_freq = self.freq_branch(freq_feat)

        return z_agg, f_freq, z_flat

    def forward(
        self,
        views: torch.Tensor,
        images: Optional[torch.Tensor] = None,
        return_uncertainty: bool = True,
    ) -> Dict[str, torch.Tensor]:
        """Forward pass.

        Args:
            views: Multi-view input [B, K, C, H, W].
            images: Original images for frequency extraction.
            return_uncertainty: Whether to compute uncertainty.

        Returns:
            Dict with 'logits', 'probs', 'uncertainty', optionally 'gen_logits'.
        """
        B, K = views.shape[:2]
        z_agg, f_freq, z_flat = self.extract_features(views, images)

        # Fusion
        if self.use_freq and f_freq is not None:
            h = torch.cat([z_agg, f_freq], dim=1)
        else:
            h = z_agg

        # Classification
        logits = self.classifier(h).squeeze(-1)  # [B]
        probs = torch.sigmoid(logits)

        result = {
            "logits": logits,
            "probs": probs,
        }

        # Uncertainty
        if return_uncertainty:
            if self.uncertainty_mode == "view_variance":
                # Get per-view predictions
                view_logits = self.classifier(z_flat).reshape(B, K)
                view_probs = torch.sigmoid(view_logits)
                uncertainty = uncertainty_from_views(view_probs, method="variance")
                result["view_probs"] = view_probs
            elif self.uncertainty_mode == "learned" and self.uncertainty_head is not None:
                _, uncertainty = self.uncertainty_head(h)
                uncertainty = uncertainty.squeeze(-1)
            else:
                uncertainty = torch.zeros(B, device=logits.device)

            result["uncertainty"] = uncertainty

        # Generator debias (for training)
        if self.gen_classifier is not None:
            # Use mean features for generator prediction
            z_mean = z_agg[:, :self.feat_dim]
            gen_logits = self.gen_classifier(z_mean.detach())
            result["gen_logits"] = gen_logits

        return result

    def predict(
        self,
        views: torch.Tensor,
        images: Optional[torch.Tensor] = None,
        uncertainty_threshold: float = 0.1,
    ) -> Dict[str, torch.Tensor]:
        """Predict with selective abstention.

        Args:
            views: Multi-view input [B, K, C, H, W].
            images: Original images.
            uncertainty_threshold: Threshold for uncertain predictions.

        Returns:
            Dict with predictions and decisions.
        """
        result = self.forward(views, images, return_uncertainty=True)

        # Decision: 0=real, 1=fake, 2=uncertain
        uncertainty = result["uncertainty"]
        probs = result["probs"]

        decision = torch.where(
            uncertainty > uncertainty_threshold,
            torch.full_like(probs, 2, dtype=torch.long),
            (probs >= 0.5).long(),
        )

        result["decision"] = decision
        result["prediction"] = (probs >= 0.5).long()

        return result
