import io
import json
import tempfile
import threading
import unittest
import tarfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from shareguard.platform import app as platform_app
from shareguard.platform.app import analyze_image_bytes, parse_multipart_image
from shareguard.platform.backends import (
    DetectionResult,
    MockDetectorBackend,
    RemoteDetectorBackend,
    ShareGuardDetectorBackend,
)
from shareguard.platform.fusion_bundle import NoisyShareFusionBundleBackend
from shareguard.platform.model_artifacts import resolve_bundle_path, resolve_checkpoint_path


def png_bytes(color=(120, 80, 40), size=(16, 12)):
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="PNG")
    return buf.getvalue()


class PlatformBackendTests(unittest.TestCase):
    def test_mock_backend_returns_demo_schema(self):
        backend = MockDetectorBackend()
        image = Image.open(io.BytesIO(png_bytes())).convert("RGB")

        result = backend.analyze(image, filename="sample.png")

        self.assertIsInstance(result, DetectionResult)
        payload = result.to_dict()
        self.assertEqual(payload["backend"], "mock")
        self.assertEqual(payload["file_name"], "sample.png")
        self.assertIn(payload["label"], {"real", "ai_generated"})
        self.assertGreaterEqual(payload["probability_ai_generated"], 0.0)
        self.assertLessEqual(payload["probability_ai_generated"], 1.0)
        self.assertIn(payload["risk_level"], {"low", "medium", "high", "uncertain"})
        self.assertTrue(payload["evidence"])

    def test_shareguard_backend_adapts_existing_detector_output(self):
        class FakeDetector:
            def predict(self, image):
                self.image_size = image.size
                return {
                    "probability": 0.91,
                    "prediction": "fake",
                    "confidence": 0.82,
                }

        backend = ShareGuardDetectorBackend(
            checkpoint_path="dummy-model.pt",
            detector_factory=lambda checkpoint_path, device=None: FakeDetector(),
        )
        image = Image.open(io.BytesIO(png_bytes(size=(20, 10)))).convert("RGB")

        result = backend.analyze(image, filename="suspect.png")
        payload = result.to_dict()

        self.assertEqual(payload["backend"], "shareguard")
        self.assertEqual(payload["label"], "ai_generated")
        self.assertAlmostEqual(payload["probability_ai_generated"], 0.91)
        self.assertAlmostEqual(payload["confidence"], 0.82)
        self.assertEqual(payload["risk_level"], "high")
        self.assertEqual(payload["image"]["width"], 20)
        self.assertEqual(payload["image"]["height"], 10)
        self.assertIn("dummy-model.pt", " ".join(payload["evidence"]))

    def test_analyze_image_bytes_adds_image_metadata(self):
        backend = MockDetectorBackend()

        payload = analyze_image_bytes(png_bytes(size=(9, 7)), backend, "tiny.png")

        self.assertEqual(payload["file_name"], "tiny.png")
        self.assertEqual(payload["image"]["width"], 9)
        self.assertEqual(payload["image"]["height"], 7)
        self.assertEqual(payload["image"]["mode"], "RGB")

    def test_analyze_image_bytes_adds_propagation_views_and_report(self):
        backend = MockDetectorBackend()

        payload = analyze_image_bytes(png_bytes(size=(32, 24)), backend, "shared.png")

        self.assertIn("propagation_views", payload)
        self.assertIn("report", payload)
        view_ids = [view["id"] for view in payload["propagation_views"]]
        self.assertEqual(
            view_ids,
            ["jpeg_q50", "resize_384", "screenshot_like", "share_heavy", "meme_like"],
        )
        for view in payload["propagation_views"]:
            self.assertTrue(view["image_data_url"].startswith("data:image/"))
            self.assertGreater(view["width"], 0)
            self.assertGreater(view["height"], 0)
        report = payload["report"]
        self.assertEqual(report["product"], "ShareGuard影像鉴真")
        self.assertIn(report["conclusion"], {"倾向真实", "疑似AI生成", "需人工复核"})
        self.assertRegex(report["report_id"], r"^SG-\d{8}-[A-F0-9]{8}$")
        self.assertRegex(report["generated_at"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(report["subject"]["file_name"], "shared.png")
        self.assertEqual(report["subject"]["image_size"], "32x24")
        self.assertEqual(report["subject"]["backend"], payload["backend"])
        self.assertEqual(
            [section["title"] for section in report["sections"]],
            ["检测结论", "传播链路证据", "处置建议"],
        )
        self.assertTrue(any("传播链路" in item for item in report["export_highlights"]))
        self.assertTrue(report["recommended_action"])
        self.assertIn("技术辅助", report["disclaimer"])

    def test_analyze_image_bytes_rejects_invalid_images(self):
        backend = MockDetectorBackend()

        with self.assertRaises(ValueError):
            analyze_image_bytes(b"not an image", backend, "bad.bin")

    def test_public_analysis_payload_hides_private_model_details(self):
        payload = {
            "file_name": "sample.png",
            "label": "ai_generated",
            "probability_ai_generated": 0.91,
            "confidence": 0.82,
            "risk_level": "high",
            "backend": "noisyshare-fusion",
            "image": {"width": 20, "height": 10, "mode": "RGB"},
            "evidence": [
                "bundle: C:/private/shareguard-noisyshare-fusion-v1",
                "method: clip_b_l_score_fusion",
                "alpha_clip_l: 0.63",
                "threshold: 0.3216482140652624",
            ],
            "raw": {
                "group_scores": {"clip_b": 0.88, "clip_l": 0.93},
                "alpha_clip_l": 0.63,
                "threshold": 0.3216482140652624,
            },
            "propagation_views": [],
            "report": {
                "subject": {"file_name": "sample.png", "backend": "noisyshare-fusion"},
                "conclusion": "疑似AI生成",
                "recommended_action": "进入人工复核",
                "sections": [],
                "review_notes": ["保留人工复核记录"],
                "disclaimer": "技术辅助结论",
            },
        }

        public = platform_app.public_analysis_payload(payload)
        serialized = json.dumps(public, ensure_ascii=False).lower()

        self.assertEqual(public["backend"], "private-inference")
        self.assertEqual(public["report"]["subject"]["backend"], "private-inference")
        self.assertNotIn("raw", public)
        self.assertNotIn("evidence", public)
        for private_marker in (
            "group_scores",
            "alpha_clip_l",
            "threshold",
            "clip_b_l_score_fusion",
            "c:/private",
            "bundle:",
        ):
            self.assertNotIn(private_marker, serialized)

    def test_static_path_resolution_serves_assets_without_traversal(self):
        css_path = platform_app.resolve_static_path("/dossier.css")

        self.assertIsNotNone(css_path)
        self.assertEqual(css_path.name, "dossier.css")
        self.assertIsNone(platform_app.resolve_static_path("/../app.py"))
        self.assertIsNone(platform_app.resolve_static_path("/%2e%2e/app.py"))

    def test_static_page_exposes_business_report_export_actions(self):
        static_dir = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static_dir / "index.html").read_text(encoding="utf-8")
        javascript = (static_dir / "dossier.js").read_text(encoding="utf-8")

        self.assertIn('id="saveHtmlReportButton"', html)
        self.assertIn('id="printReportButton"', html)
        self.assertIn('id="downloadJsonButton"', html)
        self.assertIn('id="sealButton"', html)
        self.assertIn("function buildReportHtml", javascript)
        self.assertIn("async function createEvidencePackage", javascript)

    def test_static_page_exposes_competition_judge_workflows(self):
        static_dir = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static_dir / "index.html").read_text(encoding="utf-8")
        javascript = (static_dir / "dossier.js").read_text(encoding="utf-8")

        self.assertIn("全局雷达", html)
        self.assertIn("当前案宗", html)
        self.assertIn("保全日志", html)
        self.assertIn("强制放行", html)
        self.assertIn("签封并导出", html)
        self.assertIn("物证开箱校验器", (static_dir / "verifier.html").read_text(encoding="utf-8"))
        self.assertIn("const sampleCases", javascript)
        self.assertIn("setupForensicCanvas", javascript)
        self.assertIn("new Worker(\"crypto-worker.js\")", javascript)

    def test_static_page_supports_github_pages_demo_fallback(self):
        static_dir = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        javascript = (static_dir / "dossier.js").read_text(encoding="utf-8")

        self.assertIn("static-demo", javascript)
        self.assertIn("function buildStaticDemoPayload", javascript)
        self.assertIn("function shouldUseStaticDemo", javascript)
        self.assertIn("function makeStaticPropagationViews", javascript)
        self.assertIn("function buildStaticReport", javascript)

    def test_static_bundle_contains_complete_dossier_frontend(self):
        static_dir = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        expected = {
            "index.html",
            "dossier.css",
            "dossier.js",
            "i18n.js",
            "crypto-worker.js",
            "verifier.html",
            "verifier.js",
            "assets/flagship-event.jpg",
        }
        actual = {
            path.relative_to(static_dir).as_posix()
            for path in static_dir.rglob("*")
            if path.is_file()
        }

        self.assertTrue(expected.issubset(actual), expected - actual)

    def test_static_pages_declare_a_favicon(self):
        static_dir = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"

        for page_name in ("index.html", "verifier.html"):
            html = (static_dir / page_name).read_text(encoding="utf-8")
            self.assertIn('rel="icon"', html, page_name)

    def test_github_pages_workflow_deploys_static_platform(self):
        workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "pages.yml"

        self.assertTrue(workflow.exists())
        content = workflow.read_text(encoding="utf-8")
        self.assertIn("actions/deploy-pages", content)
        self.assertIn("shareguard/platform/static", content)

    def test_parse_multipart_image_extracts_upload_field(self):
        boundary = "----shareguard-test-boundary"
        image_bytes = png_bytes(size=(5, 4))
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="image"; filename="demo.png"\r\n'
            "Content-Type: image/png\r\n"
            "\r\n"
        ).encode("utf-8") + image_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

        data, filename = parse_multipart_image(
            f"multipart/form-data; boundary={boundary}",
            body,
        )

        self.assertEqual(filename, "demo.png")
        self.assertEqual(data, image_bytes)

    def test_remote_backend_forwards_image_to_hpc_api(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["Content-Length"])
                body = self.rfile.read(length)
                requests.append({
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "content_type": self.headers.get("Content-Type"),
                    "body": body,
                })
                payload = {
                    "file_name": "remote.png",
                    "label": "ai_generated",
                    "probability_ai_generated": 0.87,
                    "confidence": 0.74,
                    "risk_level": "high",
                    "backend": "shareguard",
                    "image": {"width": 5, "height": 4, "mode": "RGB"},
                    "evidence": ["checkpoint: hpc/model.pt"],
                    "raw": {"probability": 0.87},
                }
                data = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop_server():
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

        self.addCleanup(stop_server)

        endpoint = f"http://127.0.0.1:{server.server_address[1]}/api/analyze"
        backend = RemoteDetectorBackend(endpoint, token="secret-token")
        image = Image.open(io.BytesIO(png_bytes(size=(5, 4)))).convert("RGB")

        result = backend.analyze(image, filename="local.png")
        payload = result.to_dict()

        self.assertEqual(payload["backend"], "remote:shareguard")
        self.assertEqual(payload["label"], "ai_generated")
        self.assertAlmostEqual(payload["probability_ai_generated"], 0.87)
        self.assertEqual(requests[0]["path"], "/api/analyze")
        self.assertEqual(requests[0]["auth"], "Bearer secret-token")
        self.assertIn("multipart/form-data", requests[0]["content_type"])
        self.assertIn(b'name="image"; filename="local.png"', requests[0]["body"])

    def test_resolve_checkpoint_path_uses_existing_local_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = Path(tmp) / "model.pt"
            ckpt.write_bytes(b"checkpoint")

            resolved = resolve_checkpoint_path(checkpoint=str(ckpt), model_url=None)

            self.assertEqual(resolved, ckpt)

    def test_resolve_checkpoint_path_downloads_model_url_to_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.pt"
            cache = Path(tmp) / "cache"
            source.write_bytes(b"checkpoint-from-url")

            resolved = resolve_checkpoint_path(
                checkpoint=None,
                model_url=source.as_uri(),
                cache_dir=cache,
            )

            self.assertTrue(resolved.exists())
            self.assertEqual(resolved.read_bytes(), b"checkpoint-from-url")
            self.assertEqual(resolved.parent, cache)

    def test_resolve_checkpoint_path_requires_checkpoint_or_url(self):
        with self.assertRaises(ValueError):
            resolve_checkpoint_path(checkpoint=None, model_url=None)

    def test_resolve_bundle_path_extracts_tarball(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.63,
                    "threshold": 0.72,
                    "groups": {"clip_b": [], "clip_l": []},
                }),
                encoding="utf-8",
            )
            tar_path = root / "bundle.tar.gz"
            with tarfile.open(tar_path, "w:gz") as tf:
                tf.add(bundle, arcname="shareguard-fusion-v1")

            resolved = resolve_bundle_path(
                bundle_path=None,
                bundle_url=tar_path.as_uri(),
                cache_dir=root / "cache",
            )

            self.assertTrue((resolved / "manifest.json").exists())
            self.assertEqual(resolved.name, "shareguard-fusion-v1")

    def test_resolve_bundle_path_extracts_local_archive_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.63,
                    "threshold": 0.72,
                    "groups": {"clip_b": [], "clip_l": []},
                }),
                encoding="utf-8",
            )
            tar_path = root / "bundle.tar.gz"
            with tarfile.open(tar_path, "w:gz") as tf:
                tf.add(bundle, arcname="shareguard-local-fusion-v1")

            resolved = resolve_bundle_path(
                bundle_path=str(tar_path),
                bundle_url=None,
                cache_dir=root / "cache",
            )

            self.assertTrue((resolved / "manifest.json").exists())
            self.assertEqual(resolved.name, "shareguard-local-fusion-v1")

    def test_fusion_bundle_backend_normalizes_predictor_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.63,
                    "threshold": 0.72,
                    "groups": {"clip_b": [], "clip_l": []},
                }),
                encoding="utf-8",
            )

            class FakePredictor:
                def predict(self, image):
                    return {
                        "probability_ai_generated": 0.88,
                        "confidence": 0.76,
                        "raw": {"clip_b": 0.81, "clip_l": 0.92},
                    }

            backend = NoisyShareFusionBundleBackend(
                str(root),
                predictor_factory=lambda manifest, bundle_dir, device=None: FakePredictor(),
            )
            image = Image.open(io.BytesIO(png_bytes(size=(11, 13)))).convert("RGB")

            result = backend.analyze(image, filename="bundle.png").to_dict()

            self.assertEqual(result["backend"], "noisyshare-fusion")
            self.assertEqual(result["label"], "ai_generated")
            self.assertEqual(result["risk_level"], "high")
            self.assertEqual(result["image"]["width"], 11)
            self.assertIn("clip_b_l_score_fusion", " ".join(result["evidence"]))


if __name__ == "__main__":
    unittest.main()
