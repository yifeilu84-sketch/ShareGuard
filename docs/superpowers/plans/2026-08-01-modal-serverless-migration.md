# ShareGuard Modal Serverless Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run ShareGuard's existing private fusion-bundle service on a scale-to-zero Modal T4 and preserve `https://api.shareguard.systems` through a streaming Cloudflare Worker proxy.

**Architecture:** A small Modal adapter launches the already-tested `shareguard.platform.app` HTTP server inside a GPU Web Function. A private Modal Volume contains the safetensors-only model archive and a second Volume persists public backbone caches. A Cloudflare Worker keeps the existing public API hostname, applies an origin/path boundary, and streams requests to the authenticated Modal origin.

**Tech Stack:** Python 3.11, Modal Python SDK, PyTorch CUDA 12.6, existing ShareGuard HTTP service, JavaScript ES modules, Node test runner, Cloudflare Workers/Wrangler, GitHub Pages.

## Global Constraints

- Do not commit model archives, expanded checkpoints, Modal credentials, Worker secrets, Basic-auth credentials, or a live Modal origin.
- Keep `https://shareguard.systems` as the only allowed browser origin.
- Keep the browser API contract at `/v1/ready` and `/v1/analyze` unchanged.
- Use T4 by default, `min_containers=0`, `max_containers=1`, one concurrent GPU inference, and a bounded waiting queue.
- Mount the model Volume read-only at `/models`; mount the backbone cache read-write at `/cache`.
- Require `SHAREGUARD_BUNDLE_SHA256` in production and use only the safetensors serving bundle.
- Preserve the local Named Tunnel deployment until cloud inference passes the laptop-off verification.
- Implement every production behavior after its test has failed for the expected missing-feature reason.

---

### Task 1: Modal Runtime Contract

**Files:**
- Create: `tests/test_modal_deployment.py`
- Create: `deploy/modal/shareguard_modal.py`
- Create: `requirements-modal.txt`
- Modify: `.dockerignore`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `shareguard.platform.app` and environment variables already defined by `PlatformConfig`.
- Produces: Modal app `shareguard-private-inference` and Web Function `serve`; named Volumes `shareguard-models` and `shareguard-backbone-cache`; named Secret `shareguard-production`.

- [ ] **Step 1: Write the failing Modal deployment contract tests**

```python
class ModalDeploymentTests(unittest.TestCase):
    def test_modal_adapter_uses_private_gpu_runtime(self):
        text = (ROOT / "deploy/modal/shareguard_modal.py").read_text("utf-8")
        self.assertIn('modal.App("shareguard-private-inference")', text)
        self.assertIn('gpu="T4"', text)
        self.assertIn('min_containers=0', text)
        self.assertIn('max_containers=1', text)
        self.assertIn('modal.Secret.from_name("shareguard-production")', text)
        self.assertIn('modal.web_server(PORT, startup_timeout=600)', text)

    def test_modal_adapter_mounts_model_read_only(self):
        text = (ROOT / "deploy/modal/shareguard_modal.py").read_text("utf-8")
        self.assertIn('MODEL_VOLUME.read_only()', text)
        self.assertIn('"/models":', text)
        self.assertIn('"/cache": CACHE_VOLUME', text)

    def test_modal_adapter_forces_production_fusion_bundle(self):
        text = (ROOT / "deploy/modal/shareguard_modal.py").read_text("utf-8")
        for setting in [
            '"SHAREGUARD_MODE": "production"',
            '"SHAREGUARD_BACKEND": "fusion-bundle"',
            '"SHAREGUARD_DEVICE": "cuda"',
            '"BUNDLE": MODEL_ARCHIVE',
        ]:
            self.assertIn(setting, text)
        self.assertNotIn("shareguard-noisyshare-fusion-v1-safe.tar.gz.sha256", text)

    def test_private_modal_files_are_excluded_from_build_context(self):
        dockerignore = (ROOT / ".dockerignore").read_text("utf-8")
        gitignore = (ROOT / ".gitignore").read_text("utf-8")
        self.assertIn("deploy/modal/.env", dockerignore)
        self.assertIn("deploy/modal/.env", gitignore)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `python -m pytest tests/test_modal_deployment.py -q`

Expected: FAIL because `deploy/modal/shareguard_modal.py` does not exist.

- [ ] **Step 3: Implement the minimum Modal adapter**

Create `deploy/modal/shareguard_modal.py` with this runtime shape:

```python
from pathlib import Path
import os
import subprocess
import sys

import modal

ROOT = Path(__file__).resolve().parents[2]
PORT = 7860
MODEL_ARCHIVE = "/models/shareguard-noisyshare-fusion-v1-safe.tar.gz"
MODEL_VOLUME = modal.Volume.from_name("shareguard-models", create_if_missing=True)
CACHE_VOLUME = modal.Volume.from_name("shareguard-backbone-cache", create_if_missing=True)
RUNTIME_SECRET = modal.Secret.from_name("shareguard-production")

IMAGE = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.12.1-cuda12.6-cudnn9-runtime@sha256:79c5599719e0b1afdb56ac2d14588b530283752d7ae6ec3c36e18ec9deb8b229"
    )
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install_from_requirements(str(ROOT / "requirements-platform.txt"))
    .add_local_dir(str(ROOT / "shareguard"), remote_path="/app/shareguard")
    .workdir("/app")
    .env({
        "PYTHONUNBUFFERED": "1",
        "SHAREGUARD_MODE": "production",
        "SHAREGUARD_BACKEND": "fusion-bundle",
        "SHAREGUARD_HOST": "0.0.0.0",
        "SHAREGUARD_DEVICE": "cuda",
        "SHAREGUARD_MODEL_CACHE": "/cache/models",
        "XDG_CACHE_HOME": "/cache",
        "HF_HOME": "/cache/huggingface",
        "TORCH_HOME": "/cache/torch",
        "BUNDLE": MODEL_ARCHIVE,
        "PORT": str(PORT),
    })
)

app = modal.App("shareguard-private-inference")

@app.function(
    image=IMAGE,
    gpu="T4",
    cpu=2.0,
    memory=8192,
    secrets=[RUNTIME_SECRET],
    volumes={
        "/models": MODEL_VOLUME.read_only(),
        "/cache": CACHE_VOLUME,
    },
    min_containers=0,
    max_containers=1,
    scaledown_window=300,
    timeout=900,
)
@modal.concurrent(max_inputs=16)
@modal.web_server(PORT, startup_timeout=600)
def serve():
    subprocess.Popen(
        [sys.executable, "-m", "shareguard.platform.app"],
        cwd="/app",
        env=os.environ.copy(),
    )
```

Create `requirements-modal.txt` containing `modal>=1.2,<2`. Add
`deploy/modal/.env` and `deploy/modal/*.json` to both ignore files so local
secret material cannot enter Git or a Docker context.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `python -m pytest tests/test_modal_deployment.py -q`

Expected: all tests in the file PASS.

- [ ] **Step 5: Run the existing deployment contracts**

Run: `python -m pytest tests/test_deployment_contract.py tests/test_secure_serving.py -q`

Expected: all existing deployment and safe-checkpoint tests PASS.

- [ ] **Step 6: Commit the runtime adapter**

```powershell
git add .dockerignore .gitignore requirements-modal.txt deploy/modal/shareguard_modal.py tests/test_modal_deployment.py
git commit -m "feat: add Modal private inference runtime"
```

---

### Task 2: Safe Private Artifact Upload

**Files:**
- Create: `scripts/modal/__init__.py`
- Create: `scripts/modal/upload_private_bundle.py`
- Create: `tests/test_modal_artifacts.py`
- Modify: `tests/test_modal_deployment.py`

**Interfaces:**
- Consumes: local safetensors archive path and required lowercase SHA-256.
- Produces: `validate_safe_bundle(path: Path, expected_sha256: str) -> Path` and `build_upload_command(path: Path, volume: str, remote_name: str) -> list[str]`.

- [ ] **Step 1: Write failing artifact-validation tests**

```python
def test_validate_safe_bundle_rejects_digest_mismatch(self):
    archive = self.make_bundle(checkpoint_format="safetensors")
    with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
        validate_safe_bundle(archive, "0" * 64)

def test_validate_safe_bundle_rejects_pickle_checkpoint(self):
    archive = self.make_bundle(checkpoint_format="pytorch")
    digest = sha256_file(archive)
    with self.assertRaisesRegex(ValueError, "safetensors"):
        validate_safe_bundle(archive, digest)

def test_build_upload_command_never_contains_a_secret(self):
    command = build_upload_command(Path("bundle.tar.gz"), "shareguard-models", "bundle.tar.gz")
    self.assertEqual(command[:4], [sys.executable, "-m", "modal", "volume"])
    self.assertEqual(command[4:7], ["put", "shareguard-models", "bundle.tar.gz"])
    self.assertEqual(command[-2:], ["bundle.tar.gz", "--force"])
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `python -m pytest tests/test_modal_artifacts.py -q`

Expected: FAIL because `scripts.modal.upload_private_bundle` does not exist.

- [ ] **Step 3: Implement archive validation and upload command construction**

`validate_safe_bundle` must:

1. require an existing `.tar.gz` file;
2. validate the digest format and compare it with streaming SHA-256;
3. reject links and unsafe archive paths;
4. find exactly one `manifest.json` beneath one archive root;
5. require `bundle_type == "noisyshare_fusion"` and
   `checkpoint_format == "safetensors"`;
6. require every manifest checkpoint path to end in `.safetensors` and exist in
   the archive;
7. return the resolved local archive path without extracting it.

`build_upload_command` returns:

```python
[
    sys.executable,
    "-m",
    "modal",
    "volume",
    "put",
    volume,
    str(path),
    remote_name,
    "--force",
]
```

The CLI `main()` validates first, prints only the archive name and digest, and
executes the command with `subprocess.run(command, check=True)`. It must never
print environment variables or Modal credentials.

- [ ] **Step 4: Run the artifact tests and verify GREEN**

Run: `python -m pytest tests/test_modal_artifacts.py -q`

Expected: all artifact validation tests PASS.

- [ ] **Step 5: Run both new Python test modules**

Run: `python -m pytest tests/test_modal_deployment.py tests/test_modal_artifacts.py -q`

Expected: all tests PASS.

- [ ] **Step 6: Commit the artifact uploader**

```powershell
git add scripts/modal tests/test_modal_artifacts.py tests/test_modal_deployment.py
git commit -m "feat: verify private bundles before Modal upload"
```

---

### Task 3: Streaming Cloudflare Worker

**Files:**
- Create: `deploy/cloudflare-worker/package.json`
- Create: `deploy/cloudflare-worker/wrangler.toml`
- Create: `deploy/cloudflare-worker/src/index.js`
- Create: `deploy/cloudflare-worker/test/index.test.js`
- Modify: `.gitignore`
- Modify: `tests/test_deployment_contract.py`

**Interfaces:**
- Consumes: Worker bindings `MODAL_ORIGIN` secret and `ALLOWED_ORIGIN` public variable.
- Produces: default Worker export with `fetch(request, env, ctx)` and testable `handleRequest(request, env, fetchImpl)`.

- [ ] **Step 1: Write failing Worker behavior tests**

Use Node's built-in test runner to assert:

```javascript
test("rejects an unapproved browser origin", async () => {
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/ready", {
      headers: { Origin: "https://example.com" },
    }),
    env,
    async () => new Response("unexpected"),
  );
  assert.equal(response.status, 403);
});

test("forwards only approved paths and strips spoofable identity headers", async () => {
  let forwarded;
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Origin: "https://shareguard.systems",
        Authorization: "Basic dGVzdDp0ZXN0",
        "Cf-Access-Authenticated-User-Email": "spoof@example.com",
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    env,
    async request => {
      forwarded = request;
      return new Response('{"status":"ok"}', { status: 200 });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("Authorization"), "Basic dGVzdDp0ZXN0");
  assert.equal(forwarded.headers.get("Cf-Access-Authenticated-User-Email"), null);
  assert.equal(new URL(forwarded.url).origin, env.MODAL_ORIGIN);
});

test("returns stable JSON when Modal is unavailable", async () => {
  const response = await handleRequest(allowedReadyRequest(), env, async () => {
    throw new Error("network down");
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: "upstream_unavailable", message: "Inference service is temporarily unavailable." },
  });
});
```

- [ ] **Step 2: Run the Worker tests and verify RED**

Run: `npm test --prefix deploy/cloudflare-worker`

Expected: FAIL because `src/index.js` does not exist.

- [ ] **Step 3: Implement the minimum streaming proxy**

`handleRequest` must:

- permit only `/v1/ready` with `GET` or `OPTIONS` and `/v1/analyze` with `POST`
  or `OPTIONS`;
- require exact `Origin` matching for browser requests;
- validate `MODAL_ORIGIN` as an HTTPS origin without a path, query, or fragment;
- clone request headers and delete every header whose lowercase name starts
  with `cf-access-`;
- construct an upstream `Request` with the original method, headers, body, and
  `redirect: "manual"`;
- set `Cache-Control: no-store` on every response;
- catch upstream errors and return the fixed `503` JSON payload;
- never call `request.text()`, `request.json()`, or `request.arrayBuffer()`.

`wrangler.toml` contains only:

```toml
name = "shareguard-api-gateway"
main = "src/index.js"
compatibility_date = "2026-08-01"
workers_dev = true

[vars]
ALLOWED_ORIGIN = "https://shareguard.systems"
```

The live Modal URL is supplied only by `npx wrangler secret put MODAL_ORIGIN`.

- [ ] **Step 4: Run Worker tests and verify GREEN**

Run: `npm test --prefix deploy/cloudflare-worker`

Expected: all Worker tests PASS.

- [ ] **Step 5: Add repository deployment-contract assertions**

Extend `tests/test_deployment_contract.py` to assert that the Worker source
contains `cf-access-`, `Cache-Control`, `no-store`, and `MODAL_ORIGIN`, and that
neither Worker source nor config contains `.modal.run` or an Authorization
credential literal.

- [ ] **Step 6: Run Python and Worker contracts**

Run:

```powershell
python -m pytest tests/test_deployment_contract.py tests/test_modal_deployment.py -q
npm test --prefix deploy/cloudflare-worker
```

Expected: both commands exit zero.

- [ ] **Step 7: Commit the Worker**

```powershell
git add .gitignore deploy/cloudflare-worker tests/test_deployment_contract.py
git commit -m "feat: add streaming Cloudflare inference gateway"
```

---

### Task 4: Operator Runbook and Cloud Verification Script

**Files:**
- Create: `deploy/MODAL_SERVERLESS.md`
- Create: `scripts/modal/verify_cloud_endpoint.py`
- Create: `tests/test_modal_cloud_verifier.py`
- Modify: `shareguard/platform/README.md`
- Modify: `docs/platform_github_deployment.md`

**Interfaces:**
- Consumes: endpoint URL, Basic username/password from environment, and a local image path.
- Produces: `verify_endpoint(base_url: str, username: str, password: str, image_path: Path) -> VerificationResult` and an operator runbook with deploy, warm, cutover, rollback, and cost-control commands.

- [ ] **Step 1: Write failing verifier tests with a local HTTP fixture**

Tests must prove the verifier:

- expects unauthenticated `/v1/ready` to return `401`;
- expects authenticated readiness to return `200` and status `ready`;
- sends exact Origin `https://shareguard.systems`;
- uploads a real image body with a filename header;
- rejects a response exposing `alpha_clip_l`, `group_scores`, `checkpoint`,
  `model_artifacts`, or `raw`;
- returns measured ready and inference latency without printing credentials.

- [ ] **Step 2: Run the verifier tests and verify RED**

Run: `python -m pytest tests/test_modal_cloud_verifier.py -q`

Expected: FAIL because `scripts.modal.verify_cloud_endpoint` does not exist.

- [ ] **Step 3: Implement the verifier with Python standard-library HTTP APIs**

Use `urllib.request` and `base64.b64encode`. Define:

```python
@dataclass(frozen=True)
class VerificationResult:
    ready_latency_ms: int
    inference_latency_ms: int
    model_version: str
    decision: str

def verify_endpoint(base_url, username, password, image_path): ...
```

The command-line entrypoint reads credentials from
`SHAREGUARD_HTTP_BASIC_USERNAME` and `SHAREGUARD_HTTP_BASIC_PASSWORD`, never
accepts a password argument, and prints only the four result fields.

- [ ] **Step 4: Write the complete operator runbook**

The runbook must include exact commands for:

1. installing `requirements-modal.txt` and running `modal token new`;
2. creating the `shareguard-models` and `shareguard-backbone-cache` Volumes;
3. creating an ignored `deploy/modal/.env` and loading it through
   `modal secret create shareguard-production --from-dotenv deploy/modal/.env --force`;
4. running the verified uploader with the known local archive and digest;
5. deploying `deploy/modal/shareguard_modal.py`;
6. creating the Worker `MODAL_ORIGIN` secret and deploying to workers.dev;
7. running `verify_cloud_endpoint.py` against both Modal and Worker URLs;
8. setting the custom Worker route for `api.shareguard.systems` only after both
   pass;
9. warming one container with `modal.Function.update_autoscaler` before a demo
   and restoring `min_containers=0` afterwards;
10. restoring the Named Tunnel route as rollback.

- [ ] **Step 5: Run documentation and verifier tests**

Run: `python -m pytest tests/test_modal_cloud_verifier.py tests/test_deployment_contract.py -q`

Expected: all tests PASS.

- [ ] **Step 6: Commit verifier and runbook**

```powershell
git add deploy/MODAL_SERVERLESS.md scripts/modal/verify_cloud_endpoint.py tests/test_modal_cloud_verifier.py shareguard/platform/README.md docs/platform_github_deployment.md
git commit -m "docs: add Modal deployment and verification runbook"
```

---

### Task 5: Deploy, Cut Over, and Prove Laptop Independence

**Files:**
- Modify only if validation exposes a defect: files owned by Tasks 1-4, with a failing regression test added first.
- Do not create or track any local secret, model, Modal URL, or generated Wrangler state.

**Interfaces:**
- Consumes: the local safe archive, Modal account authorization, Cloudflare account authorization, and existing ShareGuard demo credentials.
- Produces: live Modal deployment, live Worker route, and recorded non-secret verification results.

- [ ] **Step 1: Run the full local verification gate**

Run:

```powershell
python -m pytest -q
npm test --prefix deploy/cloudflare-worker
git diff --check
git status --short
```

Expected: Python and Worker suites pass; `git diff --check` exits zero; only
intentional tracked changes appear.

- [ ] **Step 2: Authenticate Modal without exposing the token**

Run `python -m modal token info`. If no active profile exists, run
`python -m modal token new --verify`, complete browser authorization, then rerun
the redacted info command. Never print or store the token in the repository.

- [ ] **Step 3: Provision Volumes, Secret, and private archive**

Create both named Volumes, create `shareguard-production` from the ignored local
dotenv file, and run the verified upload helper against the safetensors archive
with SHA-256
`9f48b64d4a90a0ae815711f2769216e16fac990e45114d3ed5256e536aeb5d82`.

- [ ] **Step 4: Deploy Modal and verify directly**

Run `python -m modal deploy deploy/modal/shareguard_modal.py`. Capture the
generated origin in process memory or an ignored local file. Run the cloud
verifier with one public demo image. Expected: unauthenticated `401`,
authenticated ready `200`, real inference `200`, and no private response keys.

- [ ] **Step 5: Deploy and verify the Worker preview**

Install the Worker package, create `MODAL_ORIGIN` with `wrangler secret put`,
deploy to workers.dev, and run the same cloud verifier against that URL.

- [ ] **Step 6: Switch `api.shareguard.systems` to the Worker**

Attach the custom Worker route only after preview verification. Do not delete
the Named Tunnel. Run authenticated ready, CORS preflight, rejected-origin,
real-image, and response-privacy checks through the fixed domain.

- [ ] **Step 7: Stop the three local services and repeat real inference**

Stop the local gateway, local model service, and cloudflared process with the
existing local stop script. Confirm ports 7860 and 7861 are closed. Repeat the
fixed-domain real-image verification. This passing request is the proof that
the laptop is no longer in the serving path.

- [ ] **Step 8: Browser acceptance test**

Open `https://shareguard.systems`, connect with the existing demo credential,
upload a public sample image, and verify the UI reports the real model version
and decision without exposing private fields.

- [ ] **Step 9: Re-run the complete verification gate**

Run:

```powershell
python -m pytest -q
npm test --prefix deploy/cloudflare-worker
git diff --check
git grep -n -I -E "(modal\.run|MODAL_TOKEN|SHAREGUARD_HTTP_BASIC_PASSWORD=.+|BEGIN (RSA|OPENSSH|PRIVATE) KEY)" -- . ":(exclude)docs/superpowers/plans/2026-08-01-modal-serverless-migration.md"
```

Expected: tests pass, formatting passes, and the secret scan returns no tracked
live origin, credential, token, or private key.

- [ ] **Step 10: Commit and push the verified migration**

```powershell
git add -A
git commit -m "deploy: move ShareGuard inference to Modal"
git push -u origin codex/modal-deployment
```

Push to `main` only after the live fixed-domain verification and laptop-off
test both pass.
