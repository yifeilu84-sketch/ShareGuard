import io
import json
import threading
import time
import unittest

from PIL import Image

from shareguard.platform.backends import DetectionResult
from shareguard.platform.config import PlatformConfig
from shareguard.platform.service import AnalysisError, AnalysisService


def image_bytes(image_format="PNG", size=(16, 12), color=(120, 80, 40)):
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format=image_format)
    return buf.getvalue()


class FakeBackend:
    name = "private-fake"

    def __init__(self, probability=0.73, confidence=0.61, risk_level="medium"):
        self.probability = probability
        self.confidence = confidence
        self.risk_level = risk_level
        self.calls = 0

    def analyze(self, image, filename="image"):
        self.calls += 1
        return DetectionResult(
            file_name=filename,
            label="ai_generated" if self.probability >= 0.5 else "real",
            probability_ai_generated=self.probability,
            confidence=self.confidence,
            risk_level=self.risk_level,
            backend=self.name,
            image={"width": image.width, "height": image.height, "mode": "RGB"},
            evidence=["threshold: 0.456", "bundle: C:/secret/model"],
            raw={
                "alpha_clip_l": 0.47,
                "group_scores": {"clip_l": 0.8},
                "model_version": "private-manifest-version",
            },
        )


class BlockingBackend(FakeBackend):
    def __init__(self):
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def analyze(self, image, filename="image"):
        self.entered.set()
        if not self.release.wait(timeout=5):
            raise RuntimeError("blocking backend timed out")
        return super().analyze(image, filename=filename)


class PlatformServiceTests(unittest.TestCase):
    def test_medium_risk_becomes_review_decision(self):
        service = AnalysisService(FakeBackend(), PlatformConfig())

        outcome = service.analyze(image_bytes(), "case.png", "sg_req_test")

        self.assertEqual(outcome.public_payload["decision"], "review")
        self.assertEqual(outcome.public_payload["decision_label"], "需要人工复核")
        self.assertEqual(outcome.public_payload["request_id"], "sg_req_test")
        self.assertEqual(outcome.public_payload["model_version"], "private-manifest-version")

    def test_high_risk_holds_and_low_risk_allows(self):
        high = AnalysisService(
            FakeBackend(probability=0.91, confidence=0.85, risk_level="high"),
            PlatformConfig(),
        ).analyze(image_bytes(), "high.png", "sg_req_high")
        low = AnalysisService(
            FakeBackend(probability=0.12, confidence=0.76, risk_level="low"),
            PlatformConfig(),
        ).analyze(image_bytes(), "low.png", "sg_req_low")

        self.assertEqual(high.public_payload["decision"], "hold")
        self.assertEqual(low.public_payload["decision"], "allow")

    def test_low_confidence_always_requires_review(self):
        service = AnalysisService(
            FakeBackend(probability=0.08, confidence=0.10, risk_level="low"),
            PlatformConfig(),
        )

        outcome = service.analyze(image_bytes(), "uncertain.png", "sg_req_uncertain")

        self.assertEqual(outcome.public_payload["decision"], "review")
        self.assertEqual(outcome.public_payload["uncertainty"], "high")

    def test_public_and_legacy_payloads_hide_private_parameters(self):
        service = AnalysisService(FakeBackend(), PlatformConfig())

        outcome = service.analyze(image_bytes(), "case.png", "sg_req_test")
        serialized = json.dumps(
            {"v1": outcome.public_payload, "legacy": outcome.legacy_payload},
            ensure_ascii=False,
        )

        for secret in [
            "alpha_clip_l",
            "group_scores",
            "threshold",
            "C:/secret/model",
            "private-fake",
        ]:
            self.assertNotIn(secret, serialized)
        self.assertEqual(outcome.legacy_payload["backend"], "private-model-api")
        self.assertEqual(outcome.legacy_payload["raw"], {
            "model_version": "private-manifest-version",
        })

    def test_public_scores_are_rounded_and_previews_are_not_returned(self):
        service = AnalysisService(
            FakeBackend(probability=0.7349, confidence=0.6129),
            PlatformConfig(public_score_decimals=2),
        )

        outcome = service.analyze(image_bytes(), "case.png", "sg_req_test")

        self.assertEqual(outcome.public_payload["ai_probability"], 0.73)
        self.assertEqual(outcome.public_payload["confidence"], 0.61)
        self.assertEqual(outcome.public_payload["propagation_views"], [])

    def test_rejects_image_over_pixel_limit_before_inference(self):
        backend = FakeBackend()
        service = AnalysisService(backend, PlatformConfig(max_image_pixels=4))

        with self.assertRaises(AnalysisError) as caught:
            service.analyze(image_bytes(size=(3, 3)), "large.png", "sg_req_test")

        self.assertEqual(caught.exception.code, "image_too_large")
        self.assertEqual(caught.exception.status, 413)
        self.assertEqual(backend.calls, 0)

    def test_rejects_payload_over_byte_limit(self):
        service = AnalysisService(FakeBackend(), PlatformConfig(max_upload_bytes=8))

        with self.assertRaises(AnalysisError) as caught:
            service.analyze(b"x" * 9, "large.png", "sg_req_test")

        self.assertEqual(caught.exception.code, "payload_too_large")
        self.assertEqual(caught.exception.status, 413)

    def test_rejects_unsupported_and_corrupt_images(self):
        service = AnalysisService(FakeBackend(), PlatformConfig())

        with self.assertRaises(AnalysisError) as unsupported:
            service.analyze(image_bytes("BMP"), "case.bmp", "sg_req_bmp")
        with self.assertRaises(AnalysisError) as corrupt:
            service.analyze(b"not-an-image", "case.png", "sg_req_corrupt")

        self.assertEqual(unsupported.exception.code, "unsupported_image")
        self.assertEqual(unsupported.exception.status, 415)
        self.assertEqual(corrupt.exception.code, "unsupported_image")

    def test_sanitizes_uploaded_filename(self):
        service = AnalysisService(FakeBackend(), PlatformConfig())

        outcome = service.analyze(
            image_bytes(),
            r"C:\private\folder\case.png",
            "sg_req_name",
        )

        self.assertEqual(outcome.legacy_payload["file_name"], "case.png")
        self.assertEqual(
            outcome.public_payload["report"]["subject"]["file_name"],
            "case.png",
        )

    def test_service_readiness_delegates_to_backend(self):
        class ReadinessBackend(FakeBackend):
            def __init__(self):
                super().__init__()
                self.ready = False

            def warmup(self):
                self.ready = True

            def is_ready(self):
                return self.ready

        backend = ReadinessBackend()
        service = AnalysisService(backend, PlatformConfig())

        self.assertFalse(service.is_ready())
        service.warmup()
        self.assertTrue(service.is_ready())

    def test_service_rejects_request_when_waiting_capacity_is_full(self):
        backend = BlockingBackend()
        service = AnalysisService(
            backend,
            PlatformConfig(
                max_inference_concurrency=1,
                max_waiting_requests=1,
            ),
        )
        worker_errors = []

        def analyze(name):
            try:
                service.analyze(image_bytes(), name, f"sg_req_{name}")
            except Exception as exc:
                worker_errors.append(exc)

        first = threading.Thread(target=analyze, args=("first",), daemon=True)
        second = threading.Thread(target=analyze, args=("second",), daemon=True)
        first.start()
        self.assertTrue(backend.entered.wait(timeout=2))
        second.start()

        deadline = time.monotonic() + 2
        while service._admission._value != 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(service._admission._value, 0)

        with self.assertRaises(AnalysisError) as caught:
            service.analyze(b"not-an-image", "third", "sg_req_third")

        self.assertEqual(caught.exception.code, "service_busy")
        self.assertEqual(caught.exception.status, 429)
        backend.release.set()
        first.join(timeout=2)
        second.join(timeout=2)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(worker_errors, [])


if __name__ == "__main__":
    unittest.main()
