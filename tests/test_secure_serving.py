import tempfile
import unittest
from pathlib import Path

import torch
from safetensors.torch import save_file

from shareguard.platform.rate_limit import MemoryRateLimiter
from shareguard.platform.safe_checkpoints import (
    load_safe_checkpoint,
    sha256_file,
    tensors_from_legacy_checkpoint,
)


def legacy_checkpoint(feature_dim=12):
    return {
        "mu": torch.zeros((1, feature_dim), dtype=torch.float32).numpy(),
        "sd": torch.ones((1, feature_dim), dtype=torch.float32).numpy(),
        "classifier": {
            "net.0.weight": torch.zeros((768, feature_dim)),
            "net.0.bias": torch.zeros(768),
            "net.3.weight": torch.zeros((256, 768)),
            "net.3.bias": torch.zeros(256),
            "net.6.weight": torch.zeros((1, 256)),
            "net.6.bias": torch.zeros(1),
        },
    }


class SafeCheckpointTests(unittest.TestCase):
    def test_legacy_serving_state_is_normalized_to_strict_tensor_schema(self):
        tensors = tensors_from_legacy_checkpoint(legacy_checkpoint())

        self.assertIn("classifier.0.weight", tensors)
        self.assertNotIn("classifier.net.0.weight", tensors)
        self.assertEqual(tuple(tensors["mu"].shape), (1, 12))

    def test_safetensors_checkpoint_requires_matching_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.safetensors"
            save_file(tensors_from_legacy_checkpoint(legacy_checkpoint()), str(path))
            digest = sha256_file(path)

            loaded = load_safe_checkpoint(path, digest)

            self.assertEqual(tuple(loaded["classifier.0.weight"].shape), (768, 12))
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                load_safe_checkpoint(path, "0" * 64)

    def test_checkpoint_schema_rejects_unexpected_tensors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.safetensors"
            tensors = tensors_from_legacy_checkpoint(legacy_checkpoint())
            tensors["private.extra"] = torch.ones(1)
            save_file(tensors, str(path))

            with self.assertRaisesRegex(ValueError, "schema mismatch"):
                load_safe_checkpoint(path, sha256_file(path))


class RateLimiterTests(unittest.TestCase):
    def test_minute_limit_returns_retry_after(self):
        now = [1_000.0]
        limiter = MemoryRateLimiter(
            per_minute=2,
            per_day=20,
            clock=lambda: now[0],
        )

        self.assertTrue(limiter.consume("actor").allowed)
        self.assertTrue(limiter.consume("actor").allowed)
        blocked = limiter.consume("actor")

        self.assertFalse(blocked.allowed)
        self.assertEqual(blocked.retry_after, 60)
        now[0] += 61
        self.assertTrue(limiter.consume("actor").allowed)

    def test_limits_are_isolated_by_actor(self):
        limiter = MemoryRateLimiter(per_minute=1)

        self.assertTrue(limiter.consume("first").allowed)
        self.assertFalse(limiter.consume("first").allowed)
        self.assertTrue(limiter.consume("second").allowed)


if __name__ == "__main__":
    unittest.main()
