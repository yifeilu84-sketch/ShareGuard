"""Loss functions for RIDE training."""

from typing import Dict, Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


class ClassificationLoss(nn.Module):
    """Binary classification loss with optional class weighting.

    Args:
        pos_weight: Weight for positive class (AI-generated).
        label_smoothing: Label smoothing factor.
    """

    def __init__(
        self,
        pos_weight: Optional[float] = None,
        label_smoothing: float = 0.0,
    ):
        super().__init__()
        self.label_smoothing = label_smoothing
        weight = torch.tensor([pos_weight]) if pos_weight else None
        self.register_buffer("pos_weight", weight)

    def forward(self, logit: torch.Tensor, label: torch.Tensor) -> torch.Tensor:
        """Compute classification loss.

        Args:
            logit: Model output logits [B, 1] or [B].
            label: Ground truth labels [B] (0=real, 1=fake).

        Returns:
            Scalar loss.
        """
        logit = logit.squeeze(-1) if logit.dim() > 1 else logit

        # Label smoothing
        if self.label_smoothing > 0:
            label = label * (1 - self.label_smoothing) + 0.5 * self.label_smoothing

        if self.pos_weight is not None:
            loss = F.binary_cross_entropy_with_logits(
                logit, label.float(), pos_weight=self.pos_weight.to(logit.device)
            )
        else:
            loss = F.binary_cross_entropy_with_logits(logit, label.float())

        return loss


class ConsistencyLoss(nn.Module):
    """Consistency loss for multi-view predictions.

    Encourages consistent predictions across different views of the same image.

    Args:
        loss_type: Type of consistency loss ('kl', 'mse', 'variance').
    """

    def __init__(self, loss_type: str = "variance"):
        super().__init__()
        self.loss_type = loss_type

    def forward(self, view_logits: torch.Tensor) -> torch.Tensor:
        """Compute consistency loss.

        Args:
            view_logits: Per-view logits [B, K, 1] or [B, K].

        Returns:
            Scalar loss.
        """
        if view_logits.dim() == 3:
            view_logits = view_logits.squeeze(-1)  # [B, K]

        # Convert to probabilities
        view_probs = torch.sigmoid(view_logits)  # [B, K]

        if self.loss_type == "variance":
            # Minimize variance across views
            loss = view_probs.var(dim=1).mean()

        elif self.loss_type == "kl":
            # KL divergence between each view and mean
            p_mean = view_probs.mean(dim=1, keepdim=True)  # [B, 1]
            # KL(p_i || p_mean) for each view
            kl = view_probs * (torch.log(view_probs + 1e-8) - torch.log(p_mean + 1e-8))
            kl += (1 - view_probs) * (torch.log(1 - view_probs + 1e-8) - torch.log(1 - p_mean + 1e-8))
            loss = kl.mean()

        elif self.loss_type == "mse":
            # MSE between each view and mean
            p_mean = view_probs.mean(dim=1, keepdim=True)
            loss = ((view_probs - p_mean) ** 2).mean()

        else:
            raise ValueError(f"Unknown loss type: {self.loss_type}")

        return loss


class RIDELoss(nn.Module):
    """Combined loss for RIDE training.

    L = L_cls + lambda * L_cons

    Args:
        lambda_cons: Weight for consistency loss.
        pos_weight: Weight for positive class.
        label_smoothing: Label smoothing factor.
        cons_type: Type of consistency loss.
    """

    def __init__(
        self,
        lambda_cons: float = 0.1,
        pos_weight: Optional[float] = None,
        label_smoothing: float = 0.0,
        cons_type: str = "variance",
    ):
        super().__init__()
        self.lambda_cons = lambda_cons
        self.cls_loss = ClassificationLoss(pos_weight=pos_weight, label_smoothing=label_smoothing)
        self.cons_loss = ConsistencyLoss(loss_type=cons_type)

    def forward(
        self,
        logit: torch.Tensor,
        label: torch.Tensor,
        view_logits: Optional[torch.Tensor] = None,
    ) -> Dict[str, torch.Tensor]:
        """Compute RIDE loss.

        Args:
            logit: Final prediction logits [B, 1].
            label: Ground truth labels [B].
            view_logits: Per-view logits [B, K, 1] for consistency loss.

        Returns:
            Dict with 'total', 'cls', 'cons' losses.
        """
        loss_cls = self.cls_loss(logit, label)

        losses = {"cls": loss_cls, "total": loss_cls}

        if view_logits is not None and self.lambda_cons > 0:
            loss_cons = self.cons_loss(view_logits)
            losses["cons"] = loss_cons
            losses["total"] = loss_cls + self.lambda_cons * loss_cons
        else:
            losses["cons"] = torch.tensor(0.0, device=logit.device)

        return losses
