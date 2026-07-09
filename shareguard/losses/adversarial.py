"""Generator debias adversarial loss.

Uses gradient reversal to prevent the model from learning
generator-specific features.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.autograd import Function


class GradientReversalFunction(Function):
    """Gradient reversal layer.

    Forward pass: identity
    Backward pass: negate gradient and scale by lambda
    """

    @staticmethod
    def forward(ctx, x, lambda_val):
        ctx.lambda_val = lambda_val
        return x.clone()

    @staticmethod
    def backward(ctx, grad_output):
        return -ctx.lambda_val * grad_output, None


class GradientReversalLayer(nn.Module):
    """Gradient reversal layer wrapper.

    Args:
        lambda_val: Scaling factor for reversed gradient.
    """

    def __init__(self, lambda_val: float = 1.0):
        super().__init__()
        self.lambda_val = lambda_val

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return GradientReversalFunction.apply(x, self.lambda_val)


class GeneratorDebiasLoss(nn.Module):
    """Generator debias loss using gradient reversal.

    The generator classifier tries to predict which generator made the image.
    Through gradient reversal, the main features become generator-invariant.

    Args:
        num_generators: Number of generator classes.
        lambda_adv: Adversarial loss weight.
    """

    def __init__(self, num_generators: int, lambda_adv: float = 0.1):
        super().__init__()
        self.lambda_adv = lambda_adv
        self.grl = GradientReversalLayer(lambda_val=1.0)
        self.ce_loss = nn.CrossEntropyLoss()

    def forward(
        self,
        features: torch.Tensor,
        generator_labels: torch.Tensor,
        gen_classifier: nn.Module,
    ) -> torch.Tensor:
        """Compute adversarial generator debias loss.

        Args:
            features: Image features [B, D].
            generator_labels: Generator class labels [B].
            gen_classifier: Generator classifier head.

        Returns:
            Scalar loss (negative because we want to maximize generator confusion).
        """
        # Apply gradient reversal
        reversed_features = self.grl(features)

        # Generator classification
        gen_logits = gen_classifier(reversed_features)

        # Cross-entropy loss
        loss = self.ce_loss(gen_logits, generator_labels)

        return loss * self.lambda_adv
