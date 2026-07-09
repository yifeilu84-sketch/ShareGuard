"""Prediction consistency loss across views."""

import torch
import torch.nn as nn


class ConsistencyLoss(nn.Module):
    """Consistency loss for multi-view predictions.

    Encourages consistent predictions across different views.

    Args:
        loss_type: Type of consistency loss ('variance', 'kl', 'mse').
    """

    def __init__(self, loss_type: str = "variance"):
        super().__init__()
        self.loss_type = loss_type

    def forward(self, view_probs: torch.Tensor) -> torch.Tensor:
        """Compute consistency loss.

        Args:
            view_probs: Per-view probabilities [B, K].

        Returns:
            Scalar loss.
        """
        if view_probs.dim() == 3:
            view_probs = view_probs.squeeze(-1)

        if self.loss_type == "variance":
            return view_probs.var(dim=1).mean()

        elif self.loss_type == "kl":
            p_mean = view_probs.mean(dim=1, keepdim=True)
            kl = view_probs * (torch.log(view_probs + 1e-8) - torch.log(p_mean + 1e-8))
            kl += (1 - view_probs) * (torch.log(1 - view_probs + 1e-8) - torch.log(1 - p_mean + 1e-8))
            return kl.mean()

        elif self.loss_type == "mse":
            p_mean = view_probs.mean(dim=1, keepdim=True)
            return ((view_probs - p_mean) ** 2).mean()

        else:
            raise ValueError(f"Unknown loss type: {self.loss_type}")
