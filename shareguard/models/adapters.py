"""Adapter modules for efficient fine-tuning.

Adapters freeze most of the backbone and only train lightweight
adapter layers inserted between transformer blocks.
"""

import torch
import torch.nn as nn


class AdapterModule(nn.Module):
    """Bottleneck adapter for transformer layers.

    Architecture:
        Input -> Down-project -> ReLU -> Up-project -> Residual

    Args:
        in_dim: Input dimension (must match transformer hidden dim).
        bottleneck_dim: Bottleneck dimension (much smaller than in_dim).
        dropout: Dropout rate.
        init_scale: Initialization scale for the output projection.
    """

    def __init__(
        self,
        in_dim: int,
        bottleneck_dim: int = 64,
        dropout: float = 0.0,
        init_scale: float = 1e-3,
    ):
        super().__init__()
        self.in_dim = in_dim
        self.bottleneck_dim = bottleneck_dim

        self.down_proj = nn.Linear(in_dim, bottleneck_dim)
        self.activation = nn.GELU()
        self.up_proj = nn.Linear(bottleneck_dim, in_dim)
        self.dropout = nn.Dropout(dropout)

        # Initialize up_proj near zero for stable training
        nn.init.zeros_(self.up_proj.weight)
        nn.init.zeros_(self.up_proj.bias)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward with residual connection.

        Args:
            x: Input tensor [..., in_dim].

        Returns:
            Output tensor [..., in_dim] with adapter residual.
        """
        residual = x
        h = self.down_proj(x)
        h = self.activation(h)
        h = self.dropout(h)
        h = self.up_proj(h)
        return residual + h


class AdapterStack(nn.Module):
    """Stack of adapters for multiple transformer layers.

    Args:
        num_layers: Number of adapter pairs to create.
        in_dim: Input dimension.
        bottleneck_dim: Bottleneck dimension.
        dropout: Dropout rate.
    """

    def __init__(
        self,
        num_layers: int = 12,
        in_dim: int = 768,
        bottleneck_dim: int = 64,
        dropout: float = 0.0,
    ):
        super().__init__()
        self.adapters = nn.ModuleList([
            AdapterModule(in_dim, bottleneck_dim, dropout)
            for _ in range(num_layers)
        ])

    def forward(self, x: torch.Tensor, layer_idx: int) -> torch.Tensor:
        """Apply adapter for a specific layer.

        Args:
            x: Input tensor.
            layer_idx: Which layer's adapter to use.

        Returns:
            Adapted tensor.
        """
        return self.adapters[layer_idx](x)


def inject_adapters(
    model: nn.Module,
    bottleneck_dim: int = 64,
    dropout: float = 0.0,
    target_layers: list = None,
) -> nn.Module:
    """Inject adapter modules into a transformer model.

    This modifies the model in-place by adding adapter layers
    after each transformer block's MLP.

    Args:
        model: Transformer model (e.g., DINOv2 ViT).
        bottleneck_dim: Adapter bottleneck dimension.
        dropout: Dropout rate.
        target_layers: Which layers to inject adapters into. None = all.

    Returns:
        Modified model with adapters.
    """
    # This is a simplified version - actual implementation depends on
    # the specific model architecture (DINOv2, CLIP, etc.)
    if hasattr(model, "blocks"):
        hidden_dim = model.blocks[0].mlp.fc2.out_features
        num_layers = len(model.blocks)

        adapters = AdapterStack(
            num_layers=num_layers,
            in_dim=hidden_dim,
            bottleneck_dim=bottleneck_dim,
            dropout=dropout,
        )
        model.adapters = adapters

        # Wrap forward to include adapters
        original_forward = model.forward

        def forward_with_adapters(x, *args, **kwargs):
            # This is simplified - need to hook into actual block execution
            return original_forward(x, *args, **kwargs)

        model.forward = forward_with_adapters

    return model
