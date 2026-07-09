"""Uncertainty estimation for ShareGuard.

Uses multi-view prediction variance as an uncertainty signal.
"""

from typing import Dict, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F


class UncertaintyHead(nn.Module):
    """Uncertainty-aware classification head.

    Outputs both prediction and uncertainty estimate.

    Args:
        in_dim: Input feature dimension.
        hidden_dim: Hidden dimension.
        dropout: Dropout rate.
    """

    def __init__(
        self,
        in_dim: int,
        hidden_dim: int = 256,
        dropout: float = 0.2,
    ):
        super().__init__()

        self.shared = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )

        # Prediction head
        self.pred_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Linear(hidden_dim // 2, 1),
        )

        # Uncertainty head (predicts variance/uncertainty)
        self.unc_head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.GELU(),
            nn.Linear(hidden_dim // 2, 1),
            nn.Softplus(),  # Ensure positive
        )

    def forward(self, x: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """Forward pass.

        Args:
            x: Input features [B, D].

        Returns:
            Tuple of (logits [B, 1], uncertainty [B, 1]).
        """
        h = self.shared(x)
        logits = self.pred_head(h)
        uncertainty = self.unc_head(h)
        return logits, uncertainty


def uncertainty_from_views(
    view_probs: torch.Tensor,
    method: str = "variance",
) -> torch.Tensor:
    """Compute uncertainty from multi-view predictions.

    Args:
        view_probs: Per-view probabilities [B, K] or [B, K, 1].
        method: Uncertainty method ('variance', 'std', 'entropy').

    Returns:
        Uncertainty scores [B].
    """
    if view_probs.dim() == 3:
        view_probs = view_probs.squeeze(-1)  # [B, K]

    if method == "variance":
        uncertainty = view_probs.var(dim=1)

    elif method == "std":
        uncertainty = view_probs.std(dim=1)

    elif method == "entropy":
        # Mean entropy across views
        mean_prob = view_probs.mean(dim=1)
        entropy = -(mean_prob * torch.log(mean_prob + 1e-8) +
                     (1 - mean_prob) * torch.log(1 - mean_prob + 1e-8))
        uncertainty = entropy

    elif method == "range":
        uncertainty = view_probs.max(dim=1).values - view_probs.min(dim=1).values

    else:
        raise ValueError(f"Unknown uncertainty method: {method}")

    return uncertainty


class SelectivePredictor:
    """Selective prediction with uncertainty-based abstention.

    When uncertainty exceeds threshold, output 'uncertain' instead of
    a real/fake prediction.

    Args:
        threshold: Uncertainty threshold for abstention.
        method: Uncertainty computation method.
    """

    def __init__(
        self,
        threshold: float = 0.1,
        method: str = "variance",
    ):
        self.threshold = threshold
        self.method = method

    def predict(
        self,
        probs: torch.Tensor,
        view_probs: Optional[torch.Tensor] = None,
        uncertainty: Optional[torch.Tensor] = None,
    ) -> Dict[str, torch.Tensor]:
        """Make selective predictions.

        Args:
            probs: Prediction probabilities [B].
            view_probs: Per-view probabilities [B, K] for uncertainty.
            uncertainty: Pre-computed uncertainty [B].

        Returns:
            Dict with 'prediction', 'uncertainty', 'decision'.
        """
        if uncertainty is None:
            if view_probs is not None:
                uncertainty = uncertainty_from_views(view_probs, self.method)
            else:
                raise ValueError("Either view_probs or uncertainty must be provided")

        # Decision: 0=real, 1=fake, 2=uncertain
        decision = torch.where(
            uncertainty > self.threshold,
            torch.full_like(probs, 2, dtype=torch.long),
            (probs >= 0.5).long(),
        )

        return {
            "probability": probs,
            "prediction": (probs >= 0.5).long(),
            "uncertainty": uncertainty,
            "decision": decision,
        }


def compute_risk_coverage(
    y_true: torch.Tensor,
    y_pred: torch.Tensor,
    uncertainty: torch.Tensor,
    coverage_levels: list = None,
) -> Dict[str, torch.Tensor]:
    """Compute risk-coverage curve.

    Risk = error rate on accepted predictions.
    Coverage = fraction of predictions accepted.

    Args:
        y_true: Ground truth labels [N].
        y_pred: Predicted labels [N].
        uncertainty: Uncertainty scores [N].
        coverage_levels: List of coverage levels to evaluate.

    Returns:
        Dict with coverage, risk, and AURC (area under risk-coverage).
    """
    if coverage_levels is None:
        coverage_levels = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]

    # Sort by uncertainty (low uncertainty = high confidence = accepted first)
    sorted_idx = torch.argsort(uncertainty)
    sorted_correct = (y_true[sorted_idx] == y_pred[sorted_idx]).float()

    n = len(y_true)
    risks = []
    coverages = []

    for cov in coverage_levels:
        n_accept = int(n * cov)
        if n_accept == 0:
            risks.append(1.0)
        else:
            risk = 1.0 - sorted_correct[:n_accept].mean().item()
            risks.append(risk)
        coverages.append(cov)

    # AURC (Area Under Risk-Coverage Curve)
    aurc = torch.trapz(torch.tensor(risks), torch.tensor(coverages)).item()

    return {
        "coverage": coverages,
        "risk": risks,
        "aurc": aurc,
    }
