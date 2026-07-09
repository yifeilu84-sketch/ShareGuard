"""LoRA (Low-Rank Adaptation) for efficient fine-tuning.

Reference: Hu et al., "LoRA: Low-Rank Adaptation of Large Language Models"
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import math


class LoRALinear(nn.Module):
    """LoRA adapter for a linear layer.

    Instead of fine-tuning the full weight matrix W (d x d),
    LoRA adds a low-rank decomposition: W + BA where B is d x r and A is r x d.

    Args:
        in_features: Input dimension.
        out_features: Output dimension.
        rank: LoRA rank (r). Lower = fewer parameters.
        alpha: Scaling factor. Effective scaling = alpha / rank.
        dropout: Dropout rate for LoRA branch.
        merge_weights: Whether to merge LoRA weights into base layer.
    """

    def __init__(
        self,
        in_features: int,
        out_features: int,
        rank: int = 4,
        alpha: float = 1.0,
        dropout: float = 0.0,
        merge_weights: bool = False,
    ):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.rank = rank
        self.alpha = alpha
        self.scaling = alpha / rank
        self.merge_weights = merge_weights

        # Base linear layer (frozen)
        self.linear = nn.Linear(in_features, out_features)

        # LoRA decomposition
        self.lora_A = nn.Linear(in_features, rank, bias=False)
        self.lora_B = nn.Linear(rank, out_features, bias=False)
        self.lora_dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()

        # Initialize A with Kaiming, B with zeros (so LoRA starts at zero)
        nn.init.kaiming_uniform_(self.lora_A.weight, a=math.sqrt(5))
        nn.init.zeros_(self.lora_B.weight)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass.

        Args:
            x: Input tensor.

        Returns:
            Output tensor with LoRA adaptation.
        """
        base_out = self.linear(x)

        if self.rank > 0:
            lora_out = self.lora_B(self.lora_A(self.lora_dropout(x))) * self.scaling
            return base_out + lora_out
        return base_out

    def merge(self):
        """Merge LoRA weights into base linear layer."""
        if self.rank > 0:
            self.linear.weight.data += (self.lora_B.weight @ self.lora_A.weight) * self.scaling
            self.lora_A.weight.data.zero_()
            self.lora_B.weight.data.zero_()

    def unmerge(self):
        """Unmerge LoRA weights from base linear layer."""
        if self.rank > 0:
            self.linear.weight.data -= (self.lora_B.weight @ self.lora_A.weight) * self.scaling


class LoRAAttention(nn.Module):
    """LoRA applied to multi-head attention Q, K, V projections.

    Args:
        q_proj: Original Q projection layer.
        k_proj: Original K projection layer.
        v_proj: Original V projection layer.
        rank: LoRA rank.
        alpha: LoRA scaling factor.
        apply_to: Which projections to apply LoRA ('q', 'k', 'v', 'all').
    """

    def __init__(
        self,
        q_proj: nn.Linear,
        k_proj: nn.Linear,
        v_proj: nn.Linear,
        rank: int = 4,
        alpha: float = 1.0,
        apply_to: str = "all",
    ):
        super().__init__()

        if apply_to in ("all", "q"):
            self.q_lora = LoRALinear(q_proj.in_features, q_proj.out_features, rank, alpha)
        else:
            self.q_lora = None

        if apply_to in ("all", "k"):
            self.k_lora = LoRALinear(k_proj.in_features, k_proj.out_features, rank, alpha)
        else:
            self.k_lora = None

        if apply_to in ("all", "v"):
            self.v_lora = LoRALinear(v_proj.in_features, v_proj.out_features, rank, alpha)
        else:
            self.v_lora = None

    def forward(
        self,
        q: torch.Tensor,
        k: torch.Tensor,
        v: torch.Tensor,
    ):
        """Apply LoRA to Q, K, V."""
        if self.q_lora is not None:
            q = q + self.q_lora(q)
        if self.k_lora is not None:
            k = k + self.k_lora(k)
        if self.v_lora is not None:
            v = v + self.v_lora(v)
        return q, k, v


def apply_lora_to_model(
    model: nn.Module,
    rank: int = 4,
    alpha: float = 1.0,
    target_modules: list = None,
) -> nn.Module:
    """Apply LoRA to a model's linear layers.

    Args:
        model: The model to apply LoRA to.
        rank: LoRA rank.
        alpha: LoRA scaling factor.
        target_modules: List of module names to apply LoRA to.
            If None, applies to all linear layers.

    Returns:
        Model with LoRA adapters.
    """
    if target_modules is None:
        target_modules = ["qkv", "proj", "fc1", "fc2"]

    for name, module in model.named_modules():
        for target in target_modules:
            if target in name and isinstance(module, nn.Linear):
                lora = LoRALinear(
                    module.in_features,
                    module.out_features,
                    rank=rank,
                    alpha=alpha,
                )
                lora.linear = module
                # Replace the module
                parent_name = ".".join(name.split(".")[:-1])
                child_name = name.split(".")[-1]
                parent = dict(model.named_modules())[parent_name]
                setattr(parent, child_name, lora)

    # Freeze non-LoRA parameters
    for name, param in model.named_parameters():
        if "lora_" not in name:
            param.requires_grad = False

    return model
