"""Strict tensor-only checkpoint handling for ShareGuard serving."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Mapping


CLASSIFIER_SHAPES = {
    "classifier.0.bias": lambda dim: (768,),
    "classifier.0.weight": lambda dim: (768, dim),
    "classifier.3.bias": lambda dim: (256,),
    "classifier.3.weight": lambda dim: (256, 768),
    "classifier.6.bias": lambda dim: (1,),
    "classifier.6.weight": lambda dim: (1, 256),
}
SAFE_TENSOR_KEYS = frozenset({"mu", "sd", *CLASSIFIER_SHAPES})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checkpoint_sha256(path: Path, expected_sha256: str) -> None:
    expected = str(expected_sha256 or "").strip().lower()
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        raise ValueError("Checkpoint SHA-256 must be 64 hexadecimal characters")
    if sha256_file(path) != expected:
        raise ValueError("Checkpoint SHA-256 mismatch")


def tensors_from_legacy_checkpoint(checkpoint: Mapping[str, Any]):
    """Extract the small serving state from a trusted legacy checkpoint."""

    import torch

    if not isinstance(checkpoint, Mapping):
        raise ValueError("Legacy checkpoint must be a mapping")
    if not {"mu", "sd", "classifier"}.issubset(checkpoint):
        raise ValueError("Legacy checkpoint is missing serving tensors")
    classifier = checkpoint["classifier"]
    if not isinstance(classifier, Mapping):
        raise ValueError("Legacy classifier state must be a mapping")

    tensors = {
        "mu": torch.as_tensor(checkpoint["mu"], dtype=torch.float32).cpu().contiguous(),
        "sd": torch.as_tensor(checkpoint["sd"], dtype=torch.float32).cpu().contiguous(),
    }
    for name, value in classifier.items():
        normalized = str(name)
        if normalized.startswith("net."):
            normalized = normalized[len("net."):]
        key = f"classifier.{normalized}"
        if key in tensors:
            raise ValueError(f"Duplicate classifier tensor: {key}")
        tensors[key] = torch.as_tensor(value).detach().cpu().contiguous()

    validate_safe_tensors(tensors)
    return tensors


def validate_safe_tensors(tensors: Mapping[str, Any]) -> int:
    """Validate the exact tensor schema and return the feature dimension."""

    import torch

    keys = frozenset(tensors)
    if keys != SAFE_TENSOR_KEYS:
        missing = sorted(SAFE_TENSOR_KEYS - keys)
        unexpected = sorted(keys - SAFE_TENSOR_KEYS)
        raise ValueError(
            f"Checkpoint tensor schema mismatch; missing={missing}, unexpected={unexpected}"
        )

    for name, tensor in tensors.items():
        if not isinstance(tensor, torch.Tensor):
            raise ValueError(f"Checkpoint value is not a tensor: {name}")
        if tensor.layout != torch.strided:
            raise ValueError(f"Checkpoint tensor must be dense: {name}")
        if not tensor.is_floating_point():
            raise ValueError(f"Checkpoint tensor must be floating point: {name}")
        if not bool(torch.isfinite(tensor).all()):
            raise ValueError(f"Checkpoint tensor contains non-finite values: {name}")

    mu = tensors["mu"]
    sd = tensors["sd"]
    if mu.ndim != 2 or mu.shape[0] != 1:
        raise ValueError("Checkpoint mu must have shape [1, feature_dim]")
    if tuple(sd.shape) != tuple(mu.shape):
        raise ValueError("Checkpoint sd must match mu shape")
    if not bool((sd > 0).all()):
        raise ValueError("Checkpoint sd must contain only positive values")

    dim = int(mu.shape[1])
    if dim < 1 or dim > 10_000:
        raise ValueError("Checkpoint feature dimension is outside the allowed range")
    for name, shape_factory in CLASSIFIER_SHAPES.items():
        expected_shape = shape_factory(dim)
        if tuple(tensors[name].shape) != expected_shape:
            raise ValueError(
                f"Checkpoint tensor shape mismatch for {name}: "
                f"expected {expected_shape}, got {tuple(tensors[name].shape)}"
            )
    return dim


def load_safe_checkpoint(path: Path, expected_sha256: str):
    """Load and validate a tensor-only serving checkpoint on CPU."""

    from safetensors.torch import load_file

    checkpoint_path = Path(path)
    if checkpoint_path.suffix.lower() != ".safetensors":
        raise ValueError("Serving checkpoints must use the .safetensors format")
    if checkpoint_path.is_symlink() or not checkpoint_path.is_file():
        raise ValueError("Serving checkpoint must be a regular file")
    verify_checkpoint_sha256(checkpoint_path, expected_sha256)
    tensors = load_file(str(checkpoint_path), device="cpu")
    validate_safe_tensors(tensors)
    return tensors
