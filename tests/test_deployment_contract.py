import re
import tempfile
import unittest
from pathlib import Path

from shareguard.platform.app import build_parser, validate_model_source
from shareguard.platform.config import PlatformConfig


ROOT = Path(__file__).resolve().parents[1]


class DeploymentContractTests(unittest.TestCase):
    def test_live_detector_disclosure_is_exact_and_separate_from_research_model(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        disclosure_path = ROOT / "docs" / "model-disclosure.md"
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")

        self.assertTrue(disclosure_path.is_file())
        disclosure = disclosure_path.read_text(encoding="utf-8")
        for marker in [
            "SPAI",
            "b1b1422f2912594ba2620b311dde5d28a230d04c",
            "Apache License 2.0",
            "ac5caaa6457172c53e36acdf665051ff292d2c3906b3911c51ed5db6844c2f87",
            "ShareGuard Protected Screening Engine",
            "not deployed",
            "uncalibrated screening score",
        ]:
            self.assertIn(marker, disclosure)
        self.assertIn("docs/model-disclosure.md", readme)
        self.assertIn(
            "private fusion model is not deployed",
            re.sub(r"\s+", " ", readme),
        )
        self.assertNotIn("private fusion model runs", readme)
        self.assertIn("not deployed", notices)
        self.assertNotIn("private shadow model", notices)

    def test_cloudflare_runbook_documents_signing_key_lifecycle(self):
        runbook_path = ROOT / "deploy" / "cloudflare-worker" / "README.md"

        self.assertTrue(runbook_path.is_file())
        runbook = runbook_path.read_text(encoding="utf-8")
        for marker in [
            "SGD_SIGNING_PRIVATE_JWK",
            "wrangler secret put SGD_SIGNING_PRIVATE_JWK",
            "runtime-config.js",
            "rotation",
            "revocation",
            "rollback",
            "git diff --cached",
        ]:
            self.assertIn(marker, runbook)
        self.assertNotRegex(runbook, r'"d"\s*:\s*"[A-Za-z0-9_-]{20,}"')
        self.assertNotIn("BEGIN PRIVATE KEY", runbook)

    def test_parser_uses_environment_defaults_and_cli_overrides(self):
        parser = build_parser({
            "PORT": "9000",
            "SHAREGUARD_BACKEND": "fusion-bundle",
            "BUNDLE": "/models/shareguard-v1",
        })

        defaults = parser.parse_args([])
        overridden = parser.parse_args(["--port", "9100", "--backend", "mock"])

        self.assertEqual(defaults.port, 9000)
        self.assertEqual(defaults.backend, "fusion-bundle")
        self.assertEqual(defaults.bundle, "/models/shareguard-v1")
        self.assertEqual(overridden.port, 9100)
        self.assertEqual(overridden.backend, "mock")

    def test_production_requires_verified_archive_and_rejects_directory_bundle(self):
        config = PlatformConfig(mode="production", api_token="secret")
        parser = build_parser({})
        archive_args = parser.parse_args([
            "--backend",
            "fusion-bundle",
            "--bundle",
            "private-model.tar.gz",
        ])

        with self.assertRaisesRegex(ValueError, "SHAREGUARD_BUNDLE_SHA256"):
            validate_model_source(config, archive_args)

        with tempfile.TemporaryDirectory() as tmp:
            directory_args = parser.parse_args([
                "--backend",
                "fusion-bundle",
                "--bundle",
                tmp,
            ])
            verified_config = PlatformConfig(
                mode="production",
                api_token="secret",
                bundle_sha256="0" * 64,
            )
            with self.assertRaisesRegex(ValueError, "verified archive"):
                validate_model_source(verified_config, directory_args)
            validate_model_source(PlatformConfig(mode="local"), directory_args)

    def test_pilot_archive_or_signed_url_requires_digest(self):
        config = PlatformConfig(mode="pilot")
        parser = build_parser({})

        for args in [
            parser.parse_args([
                "--backend",
                "fusion-bundle",
                "--bundle",
                "private-model.tar.gz",
            ]),
            parser.parse_args([
                "--backend",
                "fusion-bundle",
                "--bundle-url",
                "https://private.example/model.tar.gz",
            ]),
        ]:
            with self.assertRaisesRegex(ValueError, "SHAREGUARD_BUNDLE_SHA256"):
                validate_model_source(config, args)

    def test_production_rejects_mock_backend(self):
        config = PlatformConfig(mode="production", api_token="secret")
        args = build_parser({}).parse_args(["--backend", "mock"])

        with self.assertRaisesRegex(ValueError, "mock backend"):
            validate_model_source(config, args)

    def test_parser_supports_verified_spai_hybrid_runtime(self):
        parser = build_parser({
            "SHAREGUARD_BACKEND": "spai-hybrid",
            "SPAI_CHECKPOINT": "/models/spai.pth",
            "SPAI_SOURCE_DIR": "/opt/spai",
            "SPAI_CONFIG": "/opt/spai/configs/spai.yaml",
            "SHAREGUARD_SHADOW_SAMPLE_RATE": "0.25",
        })

        args = parser.parse_args([])

        self.assertEqual(args.backend, "spai-hybrid")
        self.assertEqual(args.spai_checkpoint, "/models/spai.pth")
        self.assertEqual(args.spai_source_dir, "/opt/spai")
        self.assertEqual(args.spai_config, "/opt/spai/configs/spai.yaml")
        self.assertEqual(args.shadow_sample_rate, 0.25)

    def test_production_spai_hybrid_requires_public_checkpoint_digest(self):
        parser = build_parser({})
        args = parser.parse_args([
            "--backend",
            "spai-hybrid",
            "--spai-checkpoint",
            "spai.pth",
            "--spai-source-dir",
            "/opt/spai",
        ])

        with self.assertRaisesRegex(ValueError, "SPAI_CHECKPOINT_SHA256"):
            validate_model_source(
                PlatformConfig(mode="production", api_token="secret"),
                args,
            )

    def test_dockerfile_runs_non_root_and_has_healthcheck(self):
        text = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn(
            "pytorch/pytorch:2.12.1-cuda12.6-cudnn9-runtime@sha256:",
            text,
        )
        self.assertIn("USER shareguard", text)
        self.assertIn("HEALTHCHECK", text)
        self.assertIn("/v1/ready", text)
        self.assertIn("XDG_CACHE_HOME=/cache", text)
        self.assertNotIn("COPY model_artifacts", text)

    def test_dockerfile_installs_dependencies_in_virtualenv(self):
        text = (ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn(
            "python -m venv --system-site-packages /opt/venv",
            text,
        )
        self.assertIn("ENV PATH=/opt/venv/bin:$PATH", text)
        self.assertNotIn("RUN pip install", text)

    def test_dockerignore_excludes_private_artifacts_and_secrets(self):
        text = (ROOT / ".dockerignore").read_text(encoding="utf-8")

        for pattern in ["model_artifacts", "*.tar.gz", ".env", "*.pem", "*.jwk"]:
            self.assertIn(pattern, text)

    def test_pilot_environment_example_contains_names_not_secrets(self):
        text = (
            ROOT / "deploy" / "shareguard.pilot.env.example"
        ).read_text(encoding="utf-8")

        self.assertIn("SHAREGUARD_MODE=pilot", text)
        self.assertIn("SHAREGUARD_BUNDLE_SHA256=", text)
        self.assertIn("SHAREGUARD_API_TOKEN=", text)
        self.assertIn("SHAREGUARD_MODEL_CACHE=/cache/models", text)
        self.assertIn(
            "BUNDLE=/models/shareguard-noisyshare-fusion-v1.tar.gz",
            text,
        )
        self.assertIn("SHAREGUARD_DEVICE=cuda", text)
        digest_setting = next(
            line for line in text.splitlines()
            if line.startswith("SHAREGUARD_BUNDLE_SHA256=")
        )
        self.assertEqual(digest_setting, "SHAREGUARD_BUNDLE_SHA256=")

    def test_pilot_compose_mounts_model_read_only(self):
        text = (
            ROOT / "deploy" / "docker-compose.pilot.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("/models:ro", text)
        self.assertIn("shareguard-cache:/cache", text)
        self.assertIn('"127.0.0.1:${PORT:-7860}:7860"', text)
        self.assertIn("gpus: all", text)
        self.assertIn("env_file:", text)
        self.assertIn("restart: unless-stopped", text)
        self.assertIn("read_only: true", text)
        self.assertIn("cap_drop:", text)
        self.assertIn("- ALL", text)
        self.assertIn("tmpfs:", text)

    def test_ci_validates_container_and_compose_contract(self):
        text = (
            ROOT / ".github" / "workflows" / "platform-tests.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("docker build", text)
        self.assertIn("docker compose", text)
        self.assertIn("shareguard.pilot.env.example", text)

    def test_windows_serving_uses_short_local_cache_path(self):
        text = (
            ROOT / "scripts" / "local" / "run_private_inference.ps1"
        ).read_text(encoding="utf-8")

        self.assertIn("SHAREGUARD_LOCAL_CACHE", text)
        self.assertIn("LOCALAPPDATA", text)
        self.assertNotIn('$Cache = Join-Path $Root ".shareguard-cache"', text)

    def test_cloudflare_worker_keeps_runtime_secrets_out_of_source(self):
        source = (
            ROOT / "deploy" / "cloudflare-worker" / "src" / "index.js"
        ).read_text(encoding="utf-8")
        config = (
            ROOT / "deploy" / "cloudflare-worker" / "wrangler.toml"
        ).read_text(encoding="utf-8")
        preview_config = (
            ROOT / "deploy" / "cloudflare-worker" / "wrangler.preview.toml"
        ).read_text(encoding="utf-8")

        for marker in [
            "cf-access-",
            "Cache-Control",
            "no-store",
            "MODAL_ORIGIN",
            "EDGE_SHARED_SECRET",
            "EDGE_AUTH_HMAC",
            "X-ShareGuard-Client-Id",
            "X-ShareGuard-Edge-Timestamp",
            "X-ShareGuard-Edge-Signature",
            "crypto.subtle",
            "RATE_LIMITER",
            "CASE_STORE",
            "ShareGuardCaseStore",
        ]:
            self.assertIn(marker, source)
        forbidden_host_suffix = ".".join(("modal", "run"))
        self.assertNotIn(forbidden_host_suffix, source)
        self.assertIsNone(
            re.search(r"Basic [A-Za-z0-9+/]{12,}={0,2}", source)
        )
        self.assertNotIn("MODAL_ORIGIN", config)
        self.assertNotIn("EDGE_AUTH_HMAC", config)
        self.assertIn('ALLOWED_ORIGIN = "https://shareguard.systems"', config)
        self.assertIn("workers_dev = false", config)
        self.assertIn("preview_urls = false", config)
        self.assertIn('pattern = "api.shareguard.systems/*"', config)
        self.assertIn('zone_name = "shareguard.systems"', config)
        self.assertIn('name = "RATE_LIMITER"', config)
        self.assertIn('class_name = "ShareGuardRateLimiter"', config)
        self.assertIn('new_sqlite_classes = ["ShareGuardRateLimiter"]', config)
        self.assertIn('name = "CASE_STORE"', config)
        self.assertIn('class_name = "ShareGuardCaseStore"', config)
        self.assertIn('new_sqlite_classes = ["ShareGuardCaseStore"]', config)
        self.assertIn('EDGE_RATE_LIMIT_PER_MINUTE = "10"', config)
        self.assertIn('EDGE_DAILY_QUOTA = "50"', config)
        self.assertIn('SGD_SIGNING_KEY_ID = "sg-signing-2026-01"', config)
        self.assertIn('SGD_SIGNING_ISSUER = "https://shareguard.systems"', config)
        self.assertIn("SGD_SIGNING_PUBLIC_JWK", config)
        self.assertNotIn("SGD_SIGNING_PRIVATE_JWK", config)
        self.assertIn('name = "shareguard-api-gateway-preview"', preview_config)
        self.assertIn("workers_dev = true", preview_config)
        self.assertIn('ALLOWED_ORIGIN = "https://shareguard.systems"', preview_config)
        self.assertIn('name = "RATE_LIMITER"', preview_config)
        self.assertIn('class_name = "ShareGuardRateLimiter"', preview_config)
        self.assertIn('name = "CASE_STORE"', preview_config)
        self.assertIn('class_name = "ShareGuardCaseStore"', preview_config)
        self.assertIn(
            'new_sqlite_classes = ["ShareGuardCaseStore"]',
            preview_config,
        )
        self.assertNotIn("api.shareguard.systems", preview_config)
        self.assertNotIn("MODAL_ORIGIN", preview_config)
        self.assertNotIn("EDGE_SHARED_SECRET", preview_config)
        self.assertNotIn("EDGE_AUTH_HMAC", preview_config)
        self.assertIn('SGD_SIGNING_KEY_ID = "sg-signing-2026-01"', preview_config)
        self.assertIn("SGD_SIGNING_PUBLIC_JWK", preview_config)
        self.assertNotIn("SGD_SIGNING_PRIVATE_JWK", preview_config)


if __name__ == "__main__":
    unittest.main()
