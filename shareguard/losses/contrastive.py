"""Degradation-invariant contrastive learning loss.

Pulls together features from different degradation views of the same image,
pushing apart features from different images.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class InvarianceLoss(nn.Module):
    """Degradation-invariant contrastive loss.

    For each image, its K degraded views should have similar representations.

    Args:
        temperature: Temperature for contrastive loss.
        mode: 'ntxent' (NT-Xent) or 'mse' (MSE between views).
    """

    def __init__(self, temperature: float = 0.07, mode: str = "mse"):
        super().__init__()
        self.temperature = temperature
        self.mode = mode

    def forward(
        self,
        view_features: torch.Tensor,
        labels: torch.Tensor,
    ) -> torch.Tensor:
        """Compute invariance loss.

        Args:
            view_features: Features from K views [B, K, D].
            labels: Image labels [B] (same label = same image class).

        Returns:
            Scalar loss.
        """
        B, K, D = view_features.shape

        if self.mode == "mse":
            # MSE between all pairs of views for same image
            # Flatten views: [B*K, D]
            features = view_features.reshape(B * K, D)

            # Compute pairwise distances within each image
            loss = 0.0
            count = 0
            for i in range(K):
                for j in range(i + 1, K):
                    diff = view_features[:, i] - view_features[:, j]
                    loss += (diff ** 2).mean()
                    count += 1

            return loss / max(count, 1)

        elif self.mode == "ntxent":
            # NT-Xent style contrastive loss
            # Positive pairs: different views of same image
            # Negative pairs: views from different images

            # Normalize features
            features = F.normalize(view_features, dim=-1)  # [B, K, D]

            # Compute similarity matrix between all views
            # [B*K, D] @ [D, B*K] = [B*K, B*K]
            flat = features.reshape(B * K, D)
            sim = flat @ flat.T / self.temperature  # [B*K, B*K]

            # Create positive mask: same image, different view
            image_ids = torch.arange(B, device=flat.device).repeat_interleave(K)
            pos_mask = (image_ids.unsqueeze(0) == image_ids.unsqueeze(1))  # [B*K, B*K]
            # Remove self-similarity
            pos_mask.fill_diagonal_(False)

            # Compute loss
            # For each anchor, loss = -log(exp(sim_pos) / sum(exp(sim_neg)))
            exp_sim = torch.exp(sim)
            # Mask out self
            mask_self = ~torch.eye(B * K, dtype=torch.bool, device=flat.device)
            exp_sim = exp_sim * mask_self.float()

            # Positive similarities
            pos_sim = (exp_sim * pos_mask.float()).sum(dim=1)
            # All similarities (excluding self)
            all_sim = exp_sim.sum(dim=1)

            # Avoid log(0)
            loss = -torch.log(pos_sim / (all_sim + 1e-8) + 1e-8)

            # Only compute for anchors that have positives
            has_pos = pos_mask.any(dim=1)
            if has_pos.any():
                loss = loss[has_pos].mean()
            else:
                loss = torch.tensor(0.0, device=flat.device)

            return loss

        else:
            raise ValueError(f"Unknown mode: {self.mode}")


class FeatureConsistencyLoss(nn.Module):
    """Feature consistency loss across views.

    Minimizes variance of features from different views of same image.

    Args:
        mode: 'variance' or 'cosine'.
    """

    def __init__(self, mode: str = "variance"):
        super().__init__()
        self.mode = mode

    def forward(self, view_features: torch.Tensor) -> torch.Tensor:
        """Compute feature consistency loss.

        Args:
            view_features: Features from K views [B, K, D].

        Returns:
            Scalar loss.
        """
        if self.mode == "variance":
            # Minimize variance across views
            return view_features.var(dim=1).mean()

        elif self.mode == "cosine":
            # Maximize cosine similarity between views
            B, K, D = view_features.shape
            features = F.normalize(view_features, dim=-1)

            loss = 0.0
            count = 0
            for i in range(K):
                for j in range(i + 1, K):
                    cos_sim = (features[:, i] * features[:, j]).sum(dim=-1)
                    loss += (1 - cos_sim).mean()
                    count += 1

            return loss / max(count, 1)

        else:
            raise ValueError(f"Unknown mode: {self.mode}")
