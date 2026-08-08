import io
import hashlib
import json
import tempfile
import threading
import unittest
import tarfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from shareguard.platform.app import analyze_image_bytes, parse_multipart_image
from shareguard.platform.backends import (
    DetectionResult,
    MockDetectorBackend,
    RemoteDetectorBackend,
    ShareGuardDetectorBackend,
)
from shareguard.platform.fusion_bundle import NoisyShareFusionBundleBackend
from shareguard.platform.model_artifacts import (
    resolve_bundle_path,
    resolve_checkpoint_path,
    verify_sha256,
)


def png_bytes(color=(120, 80, 40), size=(16, 12)):
    buf = io.BytesIO()
    Image.new("RGB", size, color=color).save(buf, format="PNG")
    return buf.getvalue()


class PlatformBackendTests(unittest.TestCase):
    def test_mock_backend_returns_demo_schema(self):
        backend = MockDetectorBackend()
        image = Image.open(io.BytesIO(png_bytes())).convert("RGB")

        backend.warmup()

        result = backend.analyze(image, filename="sample.png")

        self.assertTrue(backend.is_ready())
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

        self.assertFalse(backend.is_ready())
        backend.warmup()

        result = backend.analyze(image, filename="suspect.png")
        payload = result.to_dict()

        self.assertTrue(backend.is_ready())
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
            ["检测结论", "鲁棒性复核视图", "处置建议"],
        )
        self.assertTrue(any("鲁棒性视图" in item for item in report["export_highlights"]))
        self.assertTrue(report["recommended_action"])
        self.assertIn("技术辅助", report["disclaimer"])

    def test_analyze_image_bytes_rejects_invalid_images(self):
        backend = MockDetectorBackend()

        with self.assertRaises(ValueError):
            analyze_image_bytes(b"not an image", backend, "bad.bin")

    def test_static_page_exposes_business_report_export_actions(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")

        self.assertIn('id="saveHtmlReportButton"', html)
        self.assertIn('id="printReportButton"', html)
        self.assertIn('id="downloadJsonButton"', html)
        self.assertIn("function buildReportHtml", script)
        self.assertIn("ShareGuard影像鉴真报告", script)

    def test_production_page_excludes_sample_case_workflows(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")

        self.assertNotIn("const sampleCases", script)
        self.assertNotIn("function loadSampleCase", script)
        self.assertIn("PROTECTED SCREENING / LIVE RESULTS ONLY", html)
        self.assertIn("state.caseSummaries", script)
        self.assertIn("function renderCasePicker", script)
        self.assertIn("function renderCaseContext", script)

    def test_production_page_has_no_github_pages_demo_fallback(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")

        self.assertNotIn("产品演示模式，当前结果仅展示工作流", html)
        self.assertNotIn("static-demo", script)
        self.assertNotIn("function buildStaticDemoPayload", script)
        self.assertNotIn("function shouldUseStaticDemo", script)
        self.assertNotIn("function makeStaticPropagationViews", script)
        self.assertIn("renderAnalysisUnavailable", script)

    def test_static_page_opens_as_empty_live_trust_workbench(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")

        self.assertIn("ShareGuard影像信任工作台", html)
        self.assertIn("const EMPTY_CASE", script)
        self.assertIn("initializeProductionWorkbench", script)
        self.assertNotIn("loadSampleCase(DEFAULT_CASE_ID)", script)
        self.assertIn("LIVE MODEL RESULT", html)
        self.assertIn("建议动作", html)
        self.assertIn("AI生成模型分数", html)
        self.assertIn("尚无结论", html)
        self.assertNotIn(">Demo Engine<", html)

    def test_static_page_uses_interactive_dossier_visual_system(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        css = (static / "dossier.css").read_text(encoding="utf-8").lower()

        self.assertIn('class="dossier-shell"', html)
        self.assertIn('id="radarView"', html)
        self.assertIn('id="dossierView"', html)
        self.assertIn('id="reviewerView"', html)
        self.assertIn("--paper: #f7f5f0", css)
        self.assertIn("--ink: #1a1a1a", css)
        self.assertIn("--risk: #d32f2f", css)
        self.assertIn("--caution: #d97706", css)
        self.assertIn("--credible: #2e7d32", css)
        self.assertNotIn("linear-gradient", css)
        self.assertNotIn("box-shadow", css)
        self.assertNotIn("border-radius", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)

    def test_static_page_rejects_mock_backend_without_demo_substitution(self):
        script = (
            Path(__file__).resolve().parents[1]
            / "shareguard"
            / "platform"
            / "static"
            / "dossier.js"
        ).read_text(encoding="utf-8")

        self.assertIn('payload.backend === "mock"', script)
        self.assertIn("正式工作台拒绝演示模型响应", script)
        self.assertNotIn("setAnalysisPayload(await buildStaticDemoPayload())", script)
        self.assertIn("renderAnalysisUnavailable", script)

    def test_static_page_implements_editorial_forensics_flow(self):
        root = Path(__file__).resolve().parents[1]
        static = root / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")
        verifier = (static / "verifier.html").read_text(encoding="utf-8")
        verifier_script = (static / "verifier.js").read_text(encoding="utf-8")
        flagship = (
            static
            / "assets"
            / "flagship-event.jpg"
        )

        self.assertIn('id="waterfallFeed"', html)
        self.assertIn('id="quarantineZone"', html)
        self.assertIn('id="evidenceViewport"', html)
        self.assertIn('id="forensicCanvas"', html)
        self.assertIn('id="compareRange"', html)
        self.assertIn('id="decisionPanel"', html)
        self.assertIn('id="sealDialog"', html)
        self.assertIn('id="stageViewLabel"', html)
        self.assertIn("function selectStoredVersion", script)
        self.assertIn("function loadSelectedVersionMedia", script)
        self.assertIn("正在对比案件中的两个真实上传版本", script)
        self.assertNotIn("function selectEvidenceView", script)
        self.assertIn("function runSealingRitual", script)
        self.assertIn("function requestServerEvidencePackage", script)
        self.assertIn("shareguard.sgd.v3", script)
        self.assertIn("sgd-container.js", html)
        self.assertIn("ShareGuard Evidence Package Verifier", verifier)
        self.assertIn("crypto.subtle.digest", verifier_script)
        self.assertIn("crypto.subtle.verify", verifier_script)
        self.assertNotIn("assets/flagship-event.jpg", html)
        self.assertTrue(flagship.is_file())
        self.assertGreater(flagship.stat().st_size, 10_000)

    def test_v11_frontend_hardening_contract(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        css = (static / "dossier.css").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")
        verifier_html = (static / "verifier.html").read_text(encoding="utf-8")
        verifier_script = (static / "verifier.js").read_text(encoding="utf-8")
        locale_path = static / "i18n.js"
        crypto_worker_path = static / "crypto-worker.js"
        self.assertTrue(locale_path.is_file())
        self.assertTrue(crypto_worker_path.is_file())
        locale_script = locale_path.read_text(encoding="utf-8")
        crypto_worker = crypto_worker_path.read_text(encoding="utf-8")

        self.assertIn('src="i18n.js"', html)
        self.assertLess(html.index('src="i18n.js"'), html.index('src="dossier.js"'))
        self.assertIn('id="languageToggle"', html)
        self.assertIn('class="split-indicator"', html)
        self.assertIn("window.ShareGuardI18n", locale_script)
        self.assertIn('"zh-CN"', locale_script)
        self.assertIn('"en"', locale_script)

        self.assertIn("requestAnimationFrame(draw)", script)
        self.assertIn('document.addEventListener("visibilitychange"', script)
        self.assertNotIn("window.setInterval(draw, 180)", script)
        self.assertNotIn('new Worker("crypto-worker.js")', script)
        self.assertNotIn("runMainThreadCrypto", script)
        self.assertNotIn("function decodeDataUrl", script)
        self.assertIn("data-lens-locked", script)
        self.assertIn("typeWriterEffect", script)
        api_client = (static / "api-client.js").read_text(encoding="utf-8")
        self.assertIn('"Accept-Language"', api_client)

        self.assertIn("crypto.subtle.digest", crypto_worker)
        self.assertNotIn("crypto.subtle.sign", crypto_worker)
        self.assertNotIn("crypto.subtle.generateKey", crypto_worker)
        self.assertIn("mediaBuffer", crypto_worker)
        self.assertNotIn("stableStringify", crypto_worker)

        self.assertIn("env(safe-area-inset-bottom)", css)
        self.assertIn(".split-indicator", css)
        self.assertIn("@keyframes stamp-down", css)
        self.assertIn("@keyframes reticle-lock", css)
        self.assertIn(".quarantine-card button:focus-visible", css)
        self.assertIn(".evidence-version:focus-visible", css)

        self.assertIn('id="detachedMediaInput"', verifier_html)
        self.assertIn("verifyDetachedMedia", verifier_script)
        self.assertIn("DETACHED MEDIA", verifier_script)

    def test_public_demo_package_contains_only_safe_product_assets(self):
        root = Path(__file__).resolve().parents[1]
        public_demo = root / "public_demo"

        self.assertTrue((public_demo / "index.html").exists())
        self.assertTrue((public_demo / "README.md").exists())
        self.assertTrue((public_demo / "API.md").exists())

        combined = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(public_demo.rglob("*"))
            if path.is_file()
        )
        self.assertIn("公开展示仓库", combined)
        self.assertIn("不包含模型权重", combined)
        self.assertIn("品牌舆情", combined)
        self.assertIn("平台人工复核", combined)
        forbidden = [
            "model_artifacts",
            "fusion_bundle",
            "export_noisyshare_fusion_bundle",
            "scripts/hpc",
            "scripts/slurm",
            "shareguard/models",
            "shareguard/losses",
            "alpha_clip_l",
            "threshold",
            "group_scores",
            ".pt",
            ".pth",
        ]
        for token in forbidden:
            self.assertNotIn(token, combined)

    def test_public_demo_uses_same_dossier_visual_language(self):
        html = (Path(__file__).resolve().parents[1] / "public_demo" / "index.html").read_text(encoding="utf-8")

        self.assertIn("--paper: #f7f5f0", html.lower())
        self.assertIn("--ink: #1a1a1a", html.lower())
        self.assertIn('class="public-dossier"', html)
        self.assertIn("证据链完整", html)
        self.assertIn("私有模型 API", html)

    def test_gitignore_blocks_private_model_and_secret_artifacts(self):
        gitignore = (Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8")

        for pattern in [
            "*.ckpt",
            "*.safetensors",
            "*.onnx",
            "*.bin",
            "*.pkl",
            "*.joblib",
            "*.tar.gz",
            "*.sha256",
            ".env",
            ".env.*",
            "secrets/",
            "*.pem",
            "*.jwk",
            "reports/",
            "mlruns/",
            "runs/",
            "checkpoints/",
            "data/manifests/*.csv",
        ]:
            self.assertIn(pattern, gitignore)

    def test_github_pages_workflow_deploys_static_platform(self):
        workflow = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "pages.yml"

        self.assertTrue(workflow.exists())
        content = workflow.read_text(encoding="utf-8")
        self.assertIn("actions/deploy-pages", content)
        self.assertIn("shareguard/platform/static", content)
        self.assertIn("enablement: true", content)

    def test_github_pages_uses_memory_only_private_model_connection(self):
        static = Path(__file__).resolve().parents[1] / "shareguard" / "platform" / "static"
        html = (static / "index.html").read_text(encoding="utf-8")
        script = (static / "dossier.js").read_text(encoding="utf-8")
        api_client = (static / "api-client.js").read_text(encoding="utf-8")
        runtime = (static / "runtime-config.js").read_text(encoding="utf-8")

        self.assertIn('src="runtime-config.js"', html)
        self.assertLess(
            html.index('src="runtime-config.js"'),
            html.index('src="dossier.js"'),
        )
        self.assertIn('id="modelConnectionDialog"', html)
        self.assertIn('id="modelPassword"', html)
        self.assertIn("credentialPersistence: \"memory-only\"", runtime)
        self.assertIn("https://shareguard.systems", runtime)
        self.assertIn("https://api.shareguard.systems", runtime)
        self.assertIn("function isConfiguredRemotePage", script)
        self.assertIn("function basicAuthorization", api_client)
        self.assertIn('this.request("/v1/analyze"', api_client)
        self.assertIn("credentials: \"omit\"", api_client)
        self.assertNotIn(
            'localStorage.setItem("shareguard-model',
            script,
        )
        for forbidden in [
            "internal_api_token",
            "demo_password",
            "alpha_clip_l",
            "group_scores",
        ]:
            self.assertNotIn(forbidden, runtime)

    def test_deployment_docs_do_not_recommend_public_model_storage(self):
        root = Path(__file__).resolve().parents[1]
        docs = "\n".join([
            (root / "docs" / "platform_github_deployment.md").read_text(
                encoding="utf-8"
            ),
            (root / "shareguard" / "platform" / "README.md").read_text(
                encoding="utf-8"
            ),
        ])

        for unsafe_advice in [
            "GitHub Release asset / Git LFS / Hugging Face model repo",
            "大型模型包建议上传到 GitHub Release、Git LFS 或 Hugging Face",
        ]:
            self.assertNotIn(unsafe_advice, docs)
        self.assertIn("私有对象存储", docs)
        self.assertIn("SHAREGUARD_BUNDLE_SHA256", docs)
        self.assertIn("/v1/analyze", docs)

    def test_public_api_document_matches_v1_decision_contract(self):
        root = Path(__file__).resolve().parents[1]
        content = (root / "public_demo" / "API.md").read_text(encoding="utf-8")

        self.assertIn('"decision": "review"', content)
        self.assertIn('"decision_label": "需要人工复核"', content)
        self.assertIn("GET /v1/ready", content)
        self.assertNotIn('"model_loaded": true', content)

    def test_platform_ci_runs_full_test_discovery(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github" / "workflows" / "platform-tests.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("python -m unittest discover -s tests -v", workflow)

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
            def do_GET(self):
                payload = {"status": "ready"}
                data = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

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

        self.assertFalse(backend.is_ready())
        backend.warmup()
        self.assertTrue(backend.is_ready())

        result = backend.analyze(image, filename="local.png")
        payload = result.to_dict()

        self.assertEqual(payload["backend"], "remote:shareguard")
        self.assertEqual(payload["label"], "ai_generated")
        self.assertAlmostEqual(payload["probability_ai_generated"], 0.87)
        self.assertEqual(requests[0]["path"], "/api/analyze")
        self.assertEqual(requests[0]["auth"], "Bearer secret-token")
        self.assertIn("multipart/form-data", requests[0]["content_type"])
        self.assertIn(b'name="image"; filename="local.png"', requests[0]["body"])

    def test_remote_backend_warmup_hides_private_endpoint_failure(self):
        backend = RemoteDetectorBackend(
            "http://127.0.0.1:1/private-model/api/analyze?token=secret-query",
            timeout=0.1,
        )

        with self.assertRaises(RuntimeError) as caught:
            backend.warmup()

        message = str(caught.exception)
        self.assertIn("readiness check failed", message)
        self.assertNotIn("private-model", message)
        self.assertNotIn("secret-query", message)
        self.assertFalse(backend.is_ready())

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

    def test_private_artifact_download_error_hides_signed_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "secret-signed-model.tar.gz"
            private_url = missing.as_uri() + "?token=private-query-token"

            with self.assertRaises(RuntimeError) as caught:
                resolve_bundle_path(
                    bundle_path=None,
                    bundle_url=private_url,
                    cache_dir=Path(tmp) / "cache",
                )

            message = str(caught.exception)
            self.assertIn("artifact download failed", message)
            self.assertNotIn("private-query-token", message)
            self.assertNotIn(str(missing), message)

    def test_resolve_checkpoint_path_requires_checkpoint_or_url(self):
        with self.assertRaises(ValueError):
            resolve_checkpoint_path(checkpoint=None, model_url=None)

    def test_verify_sha256_accepts_matching_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bundle.tar.gz"
            path.write_bytes(b"private-model")
            digest = hashlib.sha256(b"private-model").hexdigest()

            verify_sha256(path, digest)

    def test_verify_sha256_rejects_mismatch_without_leaking_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secret-model-name.tar.gz"
            path.write_bytes(b"private-model")

            with self.assertRaises(ValueError) as caught:
                verify_sha256(path, "0" * 64)

            self.assertIn("SHA-256 mismatch", str(caught.exception))
            self.assertNotIn(str(path), str(caught.exception))

    def test_resolve_bundle_path_checks_local_archive_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "bundle.tar.gz"
            archive.write_bytes(b"not-the-approved-bundle")

            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                resolve_bundle_path(
                    str(archive),
                    None,
                    expected_sha256="0" * 64,
                )

    def test_resolve_bundle_path_extracts_tarball(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
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
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
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

    def test_verified_archive_replaces_tampered_extraction_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "bundle"
            bundle.mkdir()
            (bundle / "manifest.json").write_text(
                json.dumps({"bundle_type": "noisyshare_fusion"}),
                encoding="utf-8",
            )
            (bundle / "model.bin").write_bytes(b"approved-model")
            archive = root / "bundle.tar.gz"
            with tarfile.open(archive, "w:gz") as tf:
                tf.add(bundle, arcname="shareguard-cache-test")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            cache = root / "cache"

            first = resolve_bundle_path(
                str(archive),
                None,
                cache,
                expected_sha256=digest,
            )
            (first / "model.bin").write_bytes(b"tampered-model")

            second = resolve_bundle_path(
                str(archive),
                None,
                cache,
                expected_sha256=digest,
            )

            self.assertEqual(second, first)
            self.assertEqual((second / "model.bin").read_bytes(), b"approved-model")

    def test_fusion_bundle_backend_normalizes_predictor_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
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

    def test_fusion_bundle_backend_hides_private_serving_parameters(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
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
                        "raw": {
                            "group_scores": {"clip_b": 0.81, "clip_l": 0.92},
                            "threshold": 0.72,
                            "alpha_clip_l": 0.47,
                        },
                    }

            backend = NoisyShareFusionBundleBackend(
                str(root),
                predictor_factory=lambda manifest, bundle_dir, device=None: FakePredictor(),
            )
            image = Image.open(io.BytesIO(png_bytes(size=(11, 13)))).convert("RGB")

            result = backend.analyze(image, filename="bundle.png").to_dict()
            response_text = json.dumps(result, ensure_ascii=False)

            self.assertEqual(result["backend"], "noisyshare-fusion")
            self.assertIn("私有模型服务", " ".join(result["evidence"]))
            self.assertNotIn(str(root), response_text)
            self.assertNotIn("alpha_clip_l", response_text)
            self.assertNotIn("threshold", response_text)
            self.assertNotIn("group_scores", response_text)

    def test_fusion_bundle_flags_spatially_inconsistent_saturated_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
                    "threshold": 0.32,
                    "groups": {"clip_b": [], "clip_l": []},
                }),
                encoding="utf-8",
            )

            class FakePredictor:
                def __init__(self):
                    self.scores = iter([0.9999, 0.06, 0.39])

                def predict(self, image):
                    score = next(self.scores)
                    return {
                        "probability_ai_generated": score,
                        "confidence": 0.99,
                        "raw": {
                            "group_scores": {"clip_b": score, "clip_l": score},
                            "threshold": 0.32,
                            "alpha_clip_l": 0.47,
                        },
                    }

            backend = NoisyShareFusionBundleBackend(
                str(root),
                predictor_factory=lambda manifest, bundle_dir, device=None: FakePredictor(),
            )
            image = Image.open(io.BytesIO(png_bytes(size=(40, 30)))).convert("RGB")

            result = backend.analyze(image, filename="camera-photo.png").to_dict()

            self.assertTrue(result["raw"]["spatial_recheck_performed"])
            self.assertTrue(result["raw"]["selective_review"])
            self.assertEqual(
                result["raw"]["reliability_reason"],
                "spatial_score_inconsistency",
            )
            serialized = json.dumps(result, ensure_ascii=False)
            self.assertNotIn("0.06", serialized)
            self.assertNotIn("0.39", serialized)

    def test_fusion_bundle_warmup_loads_predictor_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "manifest.json").write_text(
                json.dumps({
                    "bundle_type": "noisyshare_fusion",
                    "checkpoint_format": "safetensors",
                    "method": "clip_b_l_score_fusion",
                    "alpha_clip_l": 0.47,
                    "threshold": 0.72,
                    "groups": {"clip_b": [], "clip_l": []},
                }),
                encoding="utf-8",
            )

            class FakePredictor:
                def __init__(self):
                    self.load_calls = 0

                def load(self):
                    self.load_calls += 1

            predictor = FakePredictor()
            backend = NoisyShareFusionBundleBackend(
                str(root),
                predictor_factory=lambda manifest, bundle_dir, device=None: predictor,
            )

            self.assertFalse(backend.is_ready())
            backend.warmup()
            backend.warmup()

            self.assertTrue(backend.is_ready())
            self.assertEqual(predictor.load_calls, 1)


if __name__ == "__main__":
    unittest.main()
