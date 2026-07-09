"""Calibration loss to improve confidence reliability."""

import torch
import torch.nn as nn


class CalibrationLoss(nn.Module):
    """Calibration loss to align confidence with accuracy.

    Minimizes Expected Calibration Error (ECE) during training.

    Args:
        n_bins: Number of bins for ECE computation.
        lambda_cal: Calibration loss weight.
    """

    def __init__(self, n_bins: int = 15, lambda_cal: float = 0.1):
        super().__init__()
        self.n_bins = n_bins
        self.lambda_cal = lambda_cal

    def forward(self, probs: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        """Compute calibration loss.

        Args:
            probs: Predicted probabilities [B].
            labels: Ground truth labels [B] (0 or 1).

        Returns:
            Scalar loss.
        """
        bin_edges = torch.linspace(0, 1, self.n_bins + 1, device=probs.device)
        loss = torch.tensor(0.0, device=probs.device)
        total = 0

        for i in range(self.n_bins):
            mask = (probs >= bin_edges[i]) & (probs < bin_edges[i + 1])
            if mask.sum() == 0:
                continue

            bin_acc = labels[mask].float().mean()
            bin_conf = probs[mask].mean()
            bin_size = mask.sum().float()

            loss += bin_size * (bin_acc - bin_conf) ** 2
            total += bin_size

        if total > 0:
            loss = loss / total

        return loss * self.lambda_cal
