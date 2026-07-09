"""Random seed utilities for reproducibility."""

import random
import os

import numpy as np
import torch


def set_seed(seed: int = 42, deterministic: bool = True) -> None:
    """Set random seed for reproducibility.

    Args:
        seed: Random seed value.
        deterministic: If True, set deterministic algorithms for CuDNN.
    """
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)

    if deterministic:
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
    else:
        torch.backends.cudnn.deterministic = False
        torch.backends.cudnn.benchmark = True


def get_worker_init_fn(seed: int = 42):
    """Get worker init function for DataLoader reproducibility."""

    def worker_init_fn(worker_id: int):
        worker_seed = seed + worker_id
        np.random.seed(worker_seed)
        random.seed(worker_seed)

    return worker_init_fn
