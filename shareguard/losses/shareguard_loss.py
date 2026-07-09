"""Combined ShareGuard loss function.

L_total = L_cls + λ1 L_inv + λ2 L_cons + λ3 L_gen_adv + λ4 L_cal
"""

from typing import Dict, Optional

import torch
import torch.nn as nn

from .classification import ClassificationLoss
from .contrastive import InvarianceLoss
from .consistency import ConsistencyLoss
from .adversarial import GeneratorDebiasLoss
from .calibration import CalibrationLoss


class ShareGuardLoss(nn.Module):
    """Combined loss for ShareGuard training.

    Args:
        lambda_inv: Weight for invariance loss.
        lambda_cons: Weight for consistency loss.
        lambda_gen: Weight for generator adversarial loss.
        lambda_cal: Weight for calibration loss.
        pos_weight: Weight for positive class.
        inv_mode: Invariance loss mode ('mse', 'ntxent').
        cons_type: Consistency loss type ('variance', 'kl', 'mse').
        num_generators: Number of generators (0 to disable adversarial).
    """

    def __init__(
        self,
        lambda_inv: float = 0.1,
        lambda_cons: float = 0.1,
        lambda_gen: float = 0.0,
        lambda_cal: float = 0.0,
        pos_weight: float = None,
        inv_mode: str = "mse",
        cons_type: str = "variance",
        num_generators: int = 0,
    ):
        super().__init__()
        self.lambda_inv = lambda_inv
        self.lambda_cons = lambda_cons
        self.lambda_gen = lambda_gen
        self.lambda_cal = lambda_cal

        self.cls_loss = ClassificationLoss(pos_weight=pos_weight)
        self.inv_loss = InvarianceLoss(mode=inv_mode)
        self.cons_loss = ConsistencyLoss(loss_type=cons_type)

        if num_generators > 0 and lambda_gen > 0:
            self.gen_loss = GeneratorDebiasLoss(num_generators, lambda_gen)
        else:
            self.gen_loss = None

        if lambda_cal > 0:
            self.cal_loss = CalibrationLoss()
        else:
            self.cal_loss = None

    def forward(
        self,
        logits: torch.Tensor,
        labels: torch.Tensor,
        view_probs: Optional[torch.Tensor] = None,
        view_features: Optional[torch.Tensor] = None,
        features: Optional[torch.Tensor] = None,
        generator_labels: Optional[torch.Tensor] = None,
        gen_classifier: Optional[nn.Module] = None,
    ) -> Dict[str, torch.Tensor]:
        """Compute ShareGuard loss.

        Args:
            logits: Final prediction logits [B].
            labels: Ground truth labels [B].
            view_probs: Per-view probabilities [B, K].
            view_features: Per-view features [B, K, D].
            features: Aggregated features [B, D].
            generator_labels: Generator class labels [B].
            gen_classifier: Generator classifier module.

        Returns:
            Dict with 'total', 'cls', 'inv', 'cons', 'gen', 'cal' losses.
        """
        losses = {}

        # Classification loss
        losses["cls"] = self.cls_loss(logits, labels)
        total = losses["cls"]

        # Invariance loss
        if view_features is not None and self.lambda_inv > 0:
            losses["inv"] = self.inv_loss(view_features, labels)
            total = total + self.lambda_inv * losses["inv"]
        else:
            losses["inv"] = torch.tensor(0.0, device=logits.device)

        # Consistency loss
        if view_probs is not None and self.lambda_cons > 0:
            losses["cons"] = self.cons_loss(view_probs)
            total = total + self.lambda_cons * losses["cons"]
        else:
            losses["cons"] = torch.tensor(0.0, device=logits.device)

        # Generator adversarial loss
        if (self.gen_loss is not None and features is not None and
                generator_labels is not None and gen_classifier is not None):
            losses["gen"] = self.gen_loss(features, generator_labels, gen_classifier)
            total = total + losses["gen"]
        else:
            losses["gen"] = torch.tensor(0.0, device=logits.device)

        # Calibration loss
        if self.cal_loss is not None:
            probs = torch.sigmoid(logits)
            losses["cal"] = self.cal_loss(probs, labels)
            total = total + losses["cal"]
        else:
            losses["cal"] = torch.tensor(0.0, device=logits.device)

        losses["total"] = total
        return losses
