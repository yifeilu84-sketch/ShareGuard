import json
import unittest

from PIL import Image

from shareguard.platform.backends import DetectionResult
from shareguard.platform.spai_backend import HybridDetectorBackend, SpaiDetectorBackend


class StubPredictor:
    def __init__(self, score):
        self.score = score

    def predict(self, image):
        self.last_size = image.size
        return self.score


class StubBackend:
    def __init__(self, name, score, raw=None, fail=False):
        self.name = name
        self.score = score
        self.raw = raw or {}
        self.fail = fail
        self.warmed = False

    def warmup(self):
        self.warmed = True

    def is_ready(self):
        return self.warmed

    def analyze(self, image, filename="image"):
        if self.fail:
            raise RuntimeError("shadow failure")
        label = "ai_generated" if self.score >= 0.5 else "real"
        return DetectionResult(
            file_name=filename,
            label=label,
            probability_ai_generated=self.score,
            confidence=abs(self.score - 0.5) * 2.0,
            risk_level="high" if self.score >= 0.8 else "low",
            backend=self.name,
            image={"width": image.width, "height": image.height, "mode": "RGB"},
            evidence=["stub"],
            raw=dict(self.raw),
        )


class SpaiBackendTests(unittest.TestCase):
    def test_spai_backend_normalizes_public_engine_metadata(self):
        predictor = StubPredictor(0.83)
        backend = SpaiDetectorBackend(
            checkpoint_path="spai.pth",
            source_dir="/opt/spai",
            config_path="/opt/spai/configs/spai.yaml",
            device="cpu",
            predictor_factory=lambda **_: predictor,
        )

        self.assertFalse(backend.is_ready())
        backend.warmup()
        result = backend.analyze(Image.new("RGB", (320, 240)), "case.jpg")

        self.assertTrue(backend.is_ready())
        self.assertEqual(result.backend, "spai-public-v1")
        self.assertEqual(result.label, "ai_generated")
        self.assertAlmostEqual(result.probability_ai_generated, 0.83)
        self.assertEqual(result.raw["detector_engine"], "spai-public-v1")
        self.assertEqual(result.raw["engine_role"], "public_fallback")
        self.assertEqual(result.raw["decision_layer"], "shareguard-dossier-v1")
        self.assertEqual(result.raw["source_license"], "Apache-2.0")
        self.assertFalse(result.raw["localization_available"])

    def test_hybrid_returns_primary_result_and_never_exposes_shadow_score(self):
        primary = StubBackend(
            "spai-public-v1",
            0.82,
            raw={
                "model_version": "spai-public-v1",
                "detector_engine": "spai-public-v1",
                "engine_role": "public_fallback",
                "decision_layer": "shareguard-dossier-v1",
            },
        )
        shadow = StubBackend(
            "noisyshare-fusion",
            0.13,
            raw={
                "model_version": "shareguard-private-v1",
                "private_score_secret": 0.13,
                "bundle_path": "C:/secret/private-model.tar.gz",
            },
        )
        backend = HybridDetectorBackend(
            primary=primary,
            shadow=shadow,
            shadow_sample_rate=1.0,
            sampler=lambda: 0.0,
        )

        result = backend.analyze(Image.new("RGB", (64, 64)), "case.png")
        serialized = json.dumps(result.to_dict())

        self.assertEqual(result.backend, "spai-public-v1")
        self.assertAlmostEqual(result.probability_ai_generated, 0.82)
        self.assertEqual(result.raw["shadow_evaluation"], {
            "performed": True,
            "status": "disagree",
            "engine": "shareguard-private-v1",
            "affects_decision": False,
        })
        self.assertNotIn("private_score_secret", serialized)
        self.assertNotIn("bundle_path", serialized)
        self.assertNotIn("0.13", serialized)

    def test_shadow_failure_does_not_take_public_screening_offline(self):
        primary = StubBackend(
            "spai-public-v1",
            0.18,
            raw={"model_version": "spai-public-v1"},
        )
        shadow = StubBackend("noisyshare-fusion", 0.9, fail=True)
        backend = HybridDetectorBackend(
            primary=primary,
            shadow=shadow,
            shadow_sample_rate=1.0,
            sampler=lambda: 0.0,
        )

        result = backend.analyze(Image.new("RGB", (64, 64)), "case.png")

        self.assertEqual(result.label, "real")
        self.assertEqual(result.raw["shadow_evaluation"], {
            "performed": True,
            "status": "unavailable",
            "engine": "shareguard-private-v1",
            "affects_decision": False,
        })


if __name__ == "__main__":
    unittest.main()
