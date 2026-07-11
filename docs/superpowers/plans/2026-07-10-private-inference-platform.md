# ShareGuard Private Inference Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, versioned private inference gateway that powers the existing ShareGuard Web workbench without exposing model artifacts or internal serving parameters.

**Architecture:** Keep the current detector adapters as the private inference layer, add a configuration boundary and an `AnalysisService` that turns detector output into a sanitized three-way business decision, then route both the new `/v1` contract and the legacy demo endpoint through that service. Keep GitHub Pages static and model-free; run real inference in a long-lived private GPU container using a verified artifact.

**Tech Stack:** Python 3.11, standard-library HTTP server, Pillow, existing PyTorch/timm inference backend, `unittest`, Docker, GitHub Actions.

## Global Constraints

- Preserve all existing uncommitted changes in `.gitignore`, `shareguard/platform/fusion_bundle.py`, `shareguard/platform/static/index.html`, `tests/test_platform_backend.py`, and `public_demo/`.
- Do not add model weights, signed model URLs, API tokens, internal thresholds, fusion coefficients, subgroup scores, server paths, or customer images to Git.
- Do not place a machine API token in browser JavaScript.
- Keep GitHub Pages functional as an explicitly labelled static demonstration.
- Keep the current `/api/analyze` route working while new integrations use `/v1/analyze`.
- Use `unittest`; add no Web framework or database in this phase.
- All behavior changes follow red-green-refactor. Configuration-only Docker/YAML edits are verified with build or static tests.
- Do not create implementation commits automatically while user-owned changes remain mixed in the worktree; report the final diff for an intentional commit decision.

---

### Task 1: Runtime Configuration Boundary

**Files:**
- Create: `shareguard/platform/config.py`
- Create: `tests/test_platform_config.py`

**Interfaces:**
- Produces: `PlatformConfig.from_env(environ: Mapping[str, str] | None = None) -> PlatformConfig`
- Produces: `PlatformConfig.validate() -> None`
- Produces: `PlatformConfig.is_origin_allowed(origin: str | None) -> bool`
- Consumed by: HTTP gateway, artifact resolver, and inference lifecycle tasks.

- [ ] **Step 1: Write failing configuration tests**

```python
import unittest

from shareguard.platform.config import PlatformConfig


class PlatformConfigTests(unittest.TestCase):
    def test_defaults_are_local_and_cross_origin_is_disabled(self):
        config = PlatformConfig.from_env({})
        self.assertEqual(config.mode, "local")
        self.assertEqual(config.max_upload_bytes, 10 * 1024 * 1024)
        self.assertEqual(config.max_image_pixels, 25_000_000)
        self.assertFalse(config.is_origin_allowed("https://example.com"))

    def test_allowed_origins_require_exact_match(self):
        config = PlatformConfig.from_env({
            "SHAREGUARD_ALLOWED_ORIGINS": "https://pilot.example,https://review.example"
        })
        self.assertTrue(config.is_origin_allowed("https://pilot.example"))
        self.assertFalse(config.is_origin_allowed("https://pilot.example.evil"))

    def test_production_requires_api_token(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MODE": "production"})
        with self.assertRaisesRegex(ValueError, "SHAREGUARD_API_TOKEN"):
            config.validate()

    def test_invalid_numeric_limit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHAREGUARD_MAX_UPLOAD_BYTES"):
            PlatformConfig.from_env({"SHAREGUARD_MAX_UPLOAD_BYTES": "large"})
```

- [ ] **Step 2: Run tests and verify the missing-module failure**

Run: `python -m unittest tests.test_platform_config -v`

Expected: `ModuleNotFoundError: No module named 'shareguard.platform.config'`.

- [ ] **Step 3: Implement the immutable configuration object**

```python
from dataclasses import dataclass
import os
from typing import Mapping, Optional, Tuple


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


@dataclass(frozen=True)
class PlatformConfig:
    mode: str = "local"
    api_token: Optional[str] = None
    allowed_origins: Tuple[str, ...] = ()
    max_upload_bytes: int = 10 * 1024 * 1024
    max_image_pixels: int = 25_000_000
    max_inference_concurrency: int = 1
    max_waiting_requests: int = 8
    bundle_sha256: Optional[str] = None
    model_version: str = "shareguard-private-v1"

    @classmethod
    def from_env(cls, environ: Optional[Mapping[str, str]] = None):
        env = os.environ if environ is None else environ
        origins = tuple(
            item.strip().rstrip("/")
            for item in env.get("SHAREGUARD_ALLOWED_ORIGINS", "").split(",")
            if item.strip()
        )
        return cls(
            mode=env.get("SHAREGUARD_MODE", "local").strip().lower(),
            api_token=env.get("SHAREGUARD_API_TOKEN") or None,
            allowed_origins=origins,
            max_upload_bytes=_positive_int(env, "SHAREGUARD_MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
            max_image_pixels=_positive_int(env, "SHAREGUARD_MAX_IMAGE_PIXELS", 25_000_000),
            max_inference_concurrency=_positive_int(env, "SHAREGUARD_MAX_INFERENCE_CONCURRENCY", 1),
            max_waiting_requests=_positive_int(env, "SHAREGUARD_MAX_WAITING_REQUESTS", 8),
            bundle_sha256=env.get("SHAREGUARD_BUNDLE_SHA256") or None,
            model_version=env.get("SHAREGUARD_MODEL_VERSION", "shareguard-private-v1"),
        )

    def validate(self):
        if self.mode not in {"local", "pilot", "production"}:
            raise ValueError("SHAREGUARD_MODE must be local, pilot, or production")
        if self.mode == "production" and not self.api_token:
            raise ValueError("SHAREGUARD_API_TOKEN is required in production")

    def is_origin_allowed(self, origin):
        if not origin:
            return False
        return origin.rstrip("/") in self.allowed_origins
```

- [ ] **Step 4: Run configuration tests**

Run: `python -m unittest tests.test_platform_config -v`

Expected: 4 tests pass.

---

### Task 2: Verified Private Model Artifacts

**Files:**
- Modify: `shareguard/platform/model_artifacts.py`
- Modify: `tests/test_platform_backend.py`

**Interfaces:**
- Produces: `sha256_file(path: Path) -> str`
- Produces: `verify_sha256(path: Path, expected_sha256: str | None) -> None`
- Extends: `resolve_bundle_path(..., expected_sha256: str | None = None) -> Path`
- Extends: `resolve_checkpoint_path(..., expected_sha256: str | None = None) -> Path`

- [ ] **Step 1: Add failing digest tests before changing the resolver**

```python
def test_verify_sha256_accepts_matching_digest(self):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bundle.tar.gz"
        path.write_bytes(b"private-model")
        digest = hashlib.sha256(b"private-model").hexdigest()
        verify_sha256(path, digest)

def test_verify_sha256_rejects_mismatch_without_leaking_url(self):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bundle.tar.gz"
        path.write_bytes(b"private-model")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            verify_sha256(path, "0" * 64)

def test_resolve_bundle_path_checks_local_archive_digest(self):
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "bundle.tar.gz"
        archive.write_bytes(b"not-the-approved-bundle")
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            resolve_bundle_path(str(archive), None, expected_sha256="0" * 64)
```

- [ ] **Step 2: Run the three digest tests and verify import/signature failures**

Run: `python -m unittest tests.test_platform_backend.PlatformBackendTests.test_verify_sha256_accepts_matching_digest tests.test_platform_backend.PlatformBackendTests.test_verify_sha256_rejects_mismatch_without_leaking_url tests.test_platform_backend.PlatformBackendTests.test_resolve_bundle_path_checks_local_archive_digest -v`

Expected: tests fail because `verify_sha256` and the new argument do not exist.

- [ ] **Step 3: Add streaming SHA-256 verification and invoke it before extraction**

```python
def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: Path, expected_sha256: Optional[str]) -> None:
    if not expected_sha256:
        return
    expected = expected_sha256.strip().lower()
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        raise ValueError("Expected SHA-256 must be 64 hexadecimal characters")
    if sha256_file(path) != expected:
        raise ValueError("Model artifact SHA-256 mismatch")
```

Call `verify_sha256` for local archives and downloaded/cached files before `_resolve_bundle_archive` or checkpoint return. Directories are trusted only when mounted as deployment-controlled read-only volumes.

- [ ] **Step 4: Run artifact and archive-safety tests**

Run: `python -m unittest tests.test_platform_backend -v`

Expected: all existing platform tests plus the new digest tests pass.

---

### Task 3: Sanitized Product Analysis Service

**Files:**
- Create: `shareguard/platform/service.py`
- Create: `tests/test_platform_service.py`
- Modify: `shareguard/platform/product.py`

**Interfaces:**
- Produces: `AnalysisError(status: int, code: str, public_message: str)`
- Produces: `DecisionPolicy.decide(payload: Mapping[str, Any]) -> Decision`
- Produces: `AnalysisService.analyze(image_bytes: bytes, filename: str, request_id: str) -> AnalysisOutcome`
- Produces: `AnalysisOutcome.public_payload` and `AnalysisOutcome.legacy_payload`

- [ ] **Step 1: Write failing service tests with a real image and fake detector**

```python
class FakeBackend:
    name = "private-fake"

    def analyze(self, image, filename="image"):
        return DetectionResult(
            file_name=filename,
            label="ai_generated",
            probability_ai_generated=0.73,
            confidence=0.61,
            risk_level="medium",
            backend=self.name,
            image={"width": image.width, "height": image.height, "mode": "RGB"},
            evidence=["threshold: 0.456", "bundle: C:/secret/model"],
            raw={"alpha_clip_l": 0.47, "group_scores": {"clip_l": 0.8}},
        )

def test_medium_risk_becomes_review_decision(self):
    service = AnalysisService(FakeBackend(), PlatformConfig())
    outcome = service.analyze(png_bytes(), "case.png", "sg_req_test")
    self.assertEqual(outcome.public_payload["decision"], "review")
    self.assertEqual(outcome.public_payload["request_id"], "sg_req_test")

def test_public_and_legacy_payloads_hide_private_parameters(self):
    service = AnalysisService(FakeBackend(), PlatformConfig())
    outcome = service.analyze(png_bytes(), "case.png", "sg_req_test")
    serialized = json.dumps({"v1": outcome.public_payload, "legacy": outcome.legacy_payload})
    for secret in ["alpha_clip_l", "group_scores", "threshold", "C:/secret/model"]:
        self.assertNotIn(secret, serialized)

def test_rejects_unsupported_and_oversized_images(self):
    service = AnalysisService(FakeBackend(), PlatformConfig(max_image_pixels=4))
    with self.assertRaises(AnalysisError) as caught:
        service.analyze(png_bytes(size=(3, 3)), "large.png", "sg_req_test")
    self.assertEqual(caught.exception.code, "image_too_large")
```

- [ ] **Step 2: Run service tests and verify the missing-service failure**

Run: `python -m unittest tests.test_platform_service -v`

Expected: `ModuleNotFoundError` for `shareguard.platform.service`.

- [ ] **Step 3: Implement validation, three-way decisions, and two response adapters**

Implement `AnalysisService` so it:

1. Rejects empty data and files larger than `config.max_upload_bytes`.
2. Opens with Pillow, records the decoded `image.format`, rejects animated images, checks width multiplied by height, and allows only JPEG/PNG/WEBP.
3. Calls the detector once, then adds propagation views and `build_authenticity_report`.
4. Maps `high -> hold`, `medium -> review`, low confidence `< 0.20 -> review`, otherwise `allow`.
5. Builds the `/v1` payload using `ai_probability`, `decision`, `decision_label`, `uncertainty`, report summary, warnings, propagation views, and elapsed milliseconds.
6. Builds the legacy payload using safe aliases required by the current UI, with `backend="private-model-api"`, safe evidence, and `raw={"model_version": ...}`.

The two payloads must never copy detector `evidence` or `raw` verbatim.

- [ ] **Step 4: Run service tests and product regressions**

Run: `python -m unittest tests.test_platform_service tests.test_platform_backend -v`

Expected: all tests pass.

---

### Task 4: Versioned and Authenticated HTTP Gateway

**Files:**
- Modify: `shareguard/platform/app.py`
- Create: `tests/test_platform_http.py`

**Interfaces:**
- Extends: `make_handler(backend, config: PlatformConfig | None = None, service: AnalysisService | None = None)`
- Produces endpoints: `GET /v1/health`, `GET /v1/ready`, `POST /v1/analyze`, compatibility `POST /api/analyze`.

- [ ] **Step 1: Write failing live-server HTTP tests**

Cover these exact behaviors:

```python
def test_v1_health_does_not_require_auth(self):
    status, payload, headers = self.request("GET", "/v1/health")
    self.assertEqual(status, 200)
    self.assertEqual(payload["status"], "ok")
    self.assertNotIn("backend", payload)

def test_v1_analyze_requires_configured_bearer_token(self):
    status, payload, headers = self.request("POST", "/v1/analyze", body=b"image")
    self.assertEqual(status, 401)
    self.assertEqual(payload["error"]["code"], "unauthorized")

def test_oversized_content_length_is_rejected_before_body_read(self):
    status, payload, headers = self.request(
        "POST", "/v1/analyze", body=b"x" * 9,
        headers={"Authorization": "Bearer test-token", "Content-Type": "image/png"},
    )
    self.assertEqual(status, 413)
    self.assertEqual(payload["error"]["code"], "payload_too_large")

def test_cors_header_is_only_returned_for_exact_allowlist_origin(self):
    status, payload, headers = self.request(
        "GET", "/v1/health", headers={"Origin": "https://pilot.example"}
    )
    self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://pilot.example")
```

The test server uses `PlatformConfig(api_token="test-token", allowed_origins=("https://pilot.example",), max_upload_bytes=8)` and a fake service, so no GPU is required.

- [ ] **Step 2: Run HTTP tests and verify missing route/security behavior**

Run: `python -m unittest tests.test_platform_http -v`

Expected: `/v1` tests fail against the current handler.

- [ ] **Step 3: Implement request IDs, auth, limits, safe errors, and headers**

Add helpers with these behaviors:

```python
def bearer_token_is_valid(header_value, expected_token):
    if not expected_token:
        return True
    prefix = "Bearer "
    if not header_value or not header_value.startswith(prefix):
        return False
    return secrets.compare_digest(header_value[len(prefix):], expected_token)


def error_payload(request_id, code, message):
    return {"request_id": request_id, "error": {"code": code, "message": message}}
```

Generate request IDs as `sg_req_` plus a UUID hex string. Do not include exception text in a `500` response. Add `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive Content Security Policy. Return CORS headers only for an exact configured origin; reject non-allowlisted preflight requests with `403`.

- [ ] **Step 4: Route both analyze endpoints through `AnalysisService`**

`/v1/analyze` returns `AnalysisOutcome.public_payload`. `/api/analyze` returns `AnalysisOutcome.legacy_payload` and a `Deprecation: true` header. Preserve raw-body and multipart uploads, but apply the configured byte limit before reading either form.

- [ ] **Step 5: Run HTTP and existing platform tests**

Run: `python -m unittest tests.test_platform_http tests.test_platform_backend tests.test_platform_service -v`

Expected: all tests pass and the existing static workbench contract remains green.

---

### Task 5: Model Readiness and Bounded GPU Concurrency

**Files:**
- Modify: `shareguard/platform/backends.py`
- Modify: `shareguard/platform/fusion_bundle.py`
- Modify: `shareguard/platform/service.py`
- Modify: `tests/test_platform_service.py`
- Modify: `tests/test_platform_backend.py`

**Interfaces:**
- Adds optional backend methods: `warmup() -> None`, `is_ready() -> bool`.
- Adds to `AnalysisService`: bounded queue admission and `is_ready() -> bool`.

- [ ] **Step 1: Write failing readiness and busy-service tests**

```python
def test_fusion_backend_warmup_loads_predictor_once(self):
    predictor = FakePredictor()
    backend = NoisyShareFusionBundleBackend(bundle_dir, predictor_factory=lambda *args: predictor)
    backend.warmup()
    backend.warmup()
    self.assertTrue(backend.is_ready())
    self.assertEqual(predictor.load_calls, 1)

def test_service_rejects_request_when_waiting_capacity_is_full(self):
    service = AnalysisService(
        BlockingBackend(),
        PlatformConfig(max_inference_concurrency=1, max_waiting_requests=1),
    )
    # Hold one inference and one waiter in worker threads, then submit a third request.
    with self.assertRaises(AnalysisError) as caught:
        service.analyze(png_bytes(), "third.png", "sg_req_third")
    self.assertEqual(caught.exception.code, "service_busy")
    self.assertEqual(caught.exception.status, 429)
```

- [ ] **Step 2: Run targeted tests and verify the missing lifecycle methods**

Run: `python -m unittest tests.test_platform_service tests.test_platform_backend -v`

Expected: new readiness and capacity tests fail.

- [ ] **Step 3: Implement warmup/readiness adapters and semaphores**

For the fusion backend, `warmup()` obtains the predictor and invokes its `_load()` method when present; fake predictors may expose `load()`. `is_ready()` returns true only after warmup or successful analysis. Mock backend is always ready. The remote backend reports configured readiness without exposing its endpoint.

In `AnalysisService`, use a bounded admission semaphore sized as `max_inference_concurrency + max_waiting_requests` and an inference semaphore sized as `max_inference_concurrency`. Fail admission immediately with `AnalysisError(429, "service_busy", ...)`; always release semaphores in `finally` blocks.

- [ ] **Step 4: Run lifecycle, service, and HTTP tests**

Run: `python -m unittest tests.test_platform_service tests.test_platform_http tests.test_platform_backend -v`

Expected: all tests pass without deadlocks.

---

### Task 6: CLI and Container Hardening

**Files:**
- Modify: `shareguard/platform/app.py`
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Create: `deploy/shareguard.pilot.env.example`
- Create: `deploy/docker-compose.pilot.yml`
- Create: `tests/test_deployment_contract.py`

**Interfaces:**
- CLI/env supports: `SHAREGUARD_MODE`, `SHAREGUARD_BACKEND`, `SHAREGUARD_API_TOKEN`, `SHAREGUARD_ALLOWED_ORIGINS`, `SHAREGUARD_BUNDLE_SHA256`, `BUNDLE`, `BUNDLE_URL`, `PORT`.
- Container serves the workbench and API as a non-root user and never copies `model_artifacts/`.

- [ ] **Step 1: Write failing deployment-contract tests**

```python
def test_dockerfile_runs_non_root_and_has_healthcheck(self):
    text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    self.assertIn("USER shareguard", text)
    self.assertIn("HEALTHCHECK", text)
    self.assertNotIn("COPY model_artifacts", text)

def test_pilot_environment_example_contains_names_not_secrets(self):
    text = (ROOT / "deploy" / "shareguard.pilot.env.example").read_text(encoding="utf-8")
    self.assertIn("SHAREGUARD_MODE=pilot", text)
    self.assertIn("SHAREGUARD_BUNDLE_SHA256=", text)
    digest_setting = next(
        line for line in text.splitlines()
        if line.startswith("SHAREGUARD_BUNDLE_SHA256=")
    )
    self.assertEqual(digest_setting, "SHAREGUARD_BUNDLE_SHA256=")
```

- [ ] **Step 2: Run deployment-contract tests and verify missing hardening**

Run: `python -m unittest tests.test_deployment_contract -v`

Expected: tests fail because the non-root user and deploy files do not yet exist.

- [ ] **Step 3: Make the application read deployment environment variables**

Keep command-line arguments as explicit overrides, but use environment values as defaults. Validate `PlatformConfig` before constructing the server. Pass `bundle_sha256` to artifact resolution. In `pilot` and `production` modes, warm the backend before reporting readiness.

- [ ] **Step 4: Harden the image and add the pilot compose contract**

The Dockerfile must create a non-root `shareguard` user, own `/app` and `/models`, switch with `USER shareguard`, use a Python health check against `http://127.0.0.1:${PORT}/v1/health`, and start with `python -m shareguard.platform.app`.

The compose file mounts `${SHAREGUARD_MODEL_DIR:-./private-models}:/models:ro`, exposes `${PORT:-7860}:7860`, loads `deploy/shareguard.pilot.env`, and sets `restart: unless-stopped`. The example env file contains variable names and safe local defaults but no real token, URL, digest, or model path from the user's machine.

- [ ] **Step 5: Run deployment tests and build the container**

Run: `python -m unittest tests.test_deployment_contract -v`

Expected: all deployment contract tests pass.

Run: `docker build -t shareguard-platform:pilot .`

Expected: image builds successfully without copying `model_artifacts/`. If Docker Desktop is unavailable, record that limitation and verify `.dockerignore` plus Dockerfile statically.

---

### Task 7: Documentation, Leakage Audit, and End-to-End Verification

**Files:**
- Modify: `docs/platform_github_deployment.md`
- Modify: `shareguard/platform/README.md`
- Modify: `public_demo/API.md`
- Modify: `tests/test_platform_backend.py`

**Interfaces:**
- Documents the same `/v1` contract and private artifact policy implemented by Tasks 1-6.

- [ ] **Step 1: Add a failing documentation policy test**

```python
def test_deployment_docs_do_not_recommend_public_model_storage(self):
    docs = "\n".join([
        (ROOT / "docs" / "platform_github_deployment.md").read_text(encoding="utf-8"),
        (ROOT / "shareguard" / "platform" / "README.md").read_text(encoding="utf-8"),
    ])
    self.assertNotIn("GitHub Release asset / Git LFS / Hugging Face model repo", docs)
    self.assertIn("私有对象存储", docs)
    self.assertIn("SHAREGUARD_BUNDLE_SHA256", docs)
    self.assertIn("/v1/analyze", docs)
```

- [ ] **Step 2: Run the documentation test and verify it catches the current public-storage advice**

Run: `python -m unittest tests.test_platform_backend.PlatformBackendTests.test_deployment_docs_do_not_recommend_public_model_storage -v`

Expected: test fails on the current GitHub Release/Hugging Face recommendation.

- [ ] **Step 3: Rewrite deployment documentation around the three product surfaces**

Document:

- GitHub Pages as model-free public demonstration.
- Single-origin private pilot workbench behind an access gateway.
- Private GPU container with read-only model mount or short-lived signed URL.
- SHA-256 verification, zero-retention default, Bearer Token for machine clients, exact CORS allowlist, and three-way decision semantics.
- Local mock command and private-bundle command using environment variables.
- A clear statement that the response is technical decision support, not a judicial authenticity certificate.

Remove instructions that publish model artifacts to public releases, public model hubs, Git LFS, or ordinary Git history.

- [ ] **Step 4: Run the full automated suite**

Run: `python -m unittest discover -s tests -v`

Expected: all tests pass.

- [ ] **Step 5: Run source and Git leakage checks**

Run: `python tools/check_source_leakage.py`

Expected: no tracked model artifacts or secrets are reported.

Run: `git ls-files | rg "(model_artifacts|\.pt$|\.pth$|\.ckpt$|\.safetensors$|\.tar\.gz$|\.pem$|\.env$)"`

Expected: no private model or secret file is tracked. Documentation references may appear only when they are not artifact paths.

- [ ] **Step 6: Start a local mock server and verify the user journey**

Run: `python -m shareguard.platform.app --host 127.0.0.1 --port 7860 --backend mock`

Expected: `/`, `/v1/health`, `/v1/ready`, `/v1/analyze`, and compatibility `/api/analyze` work; the static workbench renders without a real model and clearly identifies demonstration output.

- [ ] **Step 7: Inspect the final diff without committing user-owned changes**

Run: `git status --short`

Expected: only planned platform files plus the pre-existing user-owned changes are present.

Run: `git diff --check`

Expected: no whitespace errors.
