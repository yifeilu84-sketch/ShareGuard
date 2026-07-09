"""Linear probe classifier for frozen features."""

from typing import Optional

import torch
import torch.nn as nn


class LinearProbe(nn.Module):
    """Simple linear classifier for frozen backbone features.

    Args:
        in_dim: Input feature dimension.
        num_classes: Number of output classes (default: 2 for binary).
        dropout: Dropout rate.
    """

    def __init__(
        self,
        in_dim: int,
        num_classes: int = 2,
        dropout: float = 0.0,
    ):
        super().__init__()
        self.in_dim = in_dim
        self.num_classes = num_classes

        layers = []
        if dropout > 0:
            layers.append(nn.Dropout(dropout))
        layers.append(nn.Linear(in_dim, num_classes))

        self.classifier = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Classify features.

        Args:
            x: Feature tensor [B, D].

        Returns:
            Logits [B, num_classes].
        """
        return self.classifier(x)


class MLPProbe(nn.Module):
    """MLP classifier for frozen backbone features.

    Args:
        in_dim: Input feature dimension.
        hidden_dim: Hidden layer dimension.
        num_classes: Number of output classes.
        dropout: Dropout rate.
        num_layers: Number of hidden layers.
    """

    def __init__(
        self,
        in_dim: int,
        hidden_dim: int = 512,
        num_classes: int = 2,
        dropout: float = 0.2,
        num_layers: int = 2,
    ):
        super().__init__()
        self.in_dim = in_dim
        self.num_classes = num_classes

        layers = []
        current_dim = in_dim

        for i in range(num_layers):
            layers.extend([
                nn.Linear(current_dim, hidden_dim),
                nn.LayerNorm(hidden_dim),
                nn.GELU(),
                nn.Dropout(dropout),
            ])
            current_dim = hidden_dim

        layers.append(nn.Linear(current_dim, num_classes))
        self.classifier = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Classify features.

        Args:
            x: Feature tensor [B, D].

        Returns:
            Logits [B, num_classes].
        """
        return self.classifier(x)
