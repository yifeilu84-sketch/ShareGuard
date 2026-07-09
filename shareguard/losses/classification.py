"""Classification loss for real/fake detection."""

import torch
import torch.nn as nn
import torch.nn.functional as F


class ClassificationLoss(nn.Module):
    """Binary classification loss with optional class weighting.

    Args:
        pos_weight: Weight for positive class (AI-generated).
        label_smoothing: Label smoothing factor.
    """

    def __init__(self, pos_weight: float = None, label_smoothing: float = 0.0):
        super().__init__()
        self.label_smoothing = label_smoothing
        weight = torch.tensor([pos_weight]) if pos_weight else None
        self.register_buffer("pos_weight", weight)

    def forward(self, logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        """Compute classification loss.

        Args:
            logits: Model output logits [B].
            labels: Ground truth labels [B] (0=real, 1=fake).

        Returns:
            Scalar loss.
        """
        if self.label_smoothing > 0:
            labels = labels * (1 - self.label_smoothing) + 0.5 * self.label_smoothing

        if self.pos_weight is not None:
            loss = F.binary_cross_entropy_with_logits(
                logits, labels.float(), pos_weight=self.pos_weight.to(logits.device)
            )
        else:
            loss = F.binary_cross_entropy_with_logits(logits, labels.float())

        return loss
