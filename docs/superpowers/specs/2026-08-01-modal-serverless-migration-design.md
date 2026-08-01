# ShareGuard Modal Serverless Migration Design

Date: 2026-08-01
Status: Approved for implementation

## 1. Objective

Move ShareGuard's private GPU inference service from the owner's Windows laptop
and Cloudflare Tunnel to Modal Serverless GPU, while preserving:

- the public GitHub Pages frontend at `https://shareguard.systems`;
- the browser-facing API contract at `https://api.shareguard.systems`;
- the existing product-level response schema;
- the private boundary around model weights, fusion parameters, thresholds, and
  service credentials.

The finished pilot must continue to work when the owner's computer is powered
off.

## 2. Selected Approach

Use a Modal T4 Web Function that launches the existing ShareGuard HTTP server,
fronted by a small Cloudflare Worker on `api.shareguard.systems`.

The alternatives considered were:

1. Rewrite the HTTP layer as a new Modal-native FastAPI application. This would
   be clean eventually, but it would duplicate a tested security and response
   boundary during a time-sensitive migration.
2. Deploy the existing Docker image to RunPod Serverless. This remains a valid
   fallback, but requires more worker and queue plumbing and offers less useful
   free academic capacity for the pilot.
3. Keep the current Windows gateway and replace only the GPU process. This
   would still make the public service depend on the laptop and therefore does
   not meet the objective.

The selected route reuses the current `shareguard.platform.app` process and its
tests. Modal supplies GPU scheduling, scale-to-zero, secrets, persistent cache,
and a stable generated origin. Cloudflare preserves the fixed public API
hostname without requiring a paid Modal custom-domain plan.

## 3. Architecture

```text
Browser on shareguard.systems
        |
        | HTTPS + short-lived in-memory Basic credential
        v
Cloudflare Worker on api.shareguard.systems
        |
        | streamed request; exact origin/path/method allowlist
        v
Private Modal Web Function origin
        |
        | one T4 container, one concurrent GPU inference
        v
ShareGuard fusion-bundle backend
        |
        +-- /models: private Modal Volume, read-only to the application
        +-- /cache: persistent Modal Volume for public locked backbones
```

The Worker never parses or stores image bodies. It forwards the request as a
stream and returns the upstream response. The ShareGuard server remains the
authority for authentication, upload limits, quotas, CORS, inference
concurrency, public-field projection, and error responses.

## 4. Modal Runtime

The repository gains a deployment adapter under `deploy/modal/`. It will:

- build from the pinned CUDA/PyTorch base already used by `Dockerfile`;
- install only `requirements-platform.txt` and the ShareGuard package source;
- request one T4 GPU, with a configurable L4 fallback;
- mount a private model volume at `/models` and a persistent public-backbone
  cache at `/cache`;
- inject production settings through a named Modal Secret;
- bind the existing service to `0.0.0.0:7860` through
  `modal.web_server`;
- use `min_containers=0`, `max_containers=1`, and a short idle window in normal
  operation;
- expose a controlled warm mode by changing the autoscaler to
  `min_containers=1` before a competition or investor demonstration.

The server startup timeout will allow first-time backbone loading, but a normal
HTTP request must still finish inside Modal's Web Function request limit.

## 5. Private Artifact Provisioning

The safe serving archive is uploaded directly from the local ignored
`model_artifacts` directory to the private Modal model volume. It is never
copied into Git, a public container layer, GitHub Actions, or Cloudflare.

Provisioning must verify the local SHA-256 before upload. Runtime startup must
verify the same digest again before extraction. The expected pilot artifact is
the safetensors-only archive produced by the existing trusted migration tool.

Public Timm/Hugging Face backbone files may be downloaded by the first Modal
container into the persistent cache. Existing `deploy/backbone-lock.json`
verification remains available for a pre-populated cache. No private
checkpoint may use pickle-based loading.

## 6. Cloudflare Edge Gateway

The repository gains a Worker package under `deploy/cloudflare-worker/` with no
secret values committed. Its responsibilities are deliberately narrow:

- serve only `/v1/ready`, `/v1/analyze`, and their required `OPTIONS` requests;
- reject browser origins other than `https://shareguard.systems`;
- proxy to a `MODAL_ORIGIN` Worker secret;
- preserve the browser authorization header for ShareGuard's existing Basic
  authentication check;
- strip untrusted Cloudflare Access identity headers before forwarding;
- stream request and response bodies without logging media or credentials;
- return a stable `503` JSON response when the upstream is unavailable.

The generated Modal origin remains protected by the same production Basic
credential. Discovering it therefore does not bypass authentication. A later
version may split browser and origin credentials, but that is outside this
migration's minimum scope.

## 7. Security Properties

- Model archives, expanded weights, credentials, Modal tokens, and the Modal
  origin are ignored by Git and excluded from container build contexts.
- The frontend receives no model path, threshold, alpha, seed score, or raw
  checkpoint metadata.
- CORS remains an exact origin allowlist, not a wildcard.
- Upload and pixel limits remain enforced before inference.
- GPU inference concurrency remains one per container, with a bounded waiting
  queue.
- The Worker does not cache API responses and never writes request bodies.
- Logs contain request identifiers, statuses, and latency only.

## 8. Rollout and Rollback

Rollout is staged:

1. Deploy Modal under its generated origin and verify authenticated ready and
   real-image inference calls directly.
2. Deploy the Worker on a temporary workers.dev URL and run the same contract
   tests through it.
3. Change the `api.shareguard.systems` route from the Named Tunnel to the
   Worker only after both checks pass.
4. Run a browser upload from `https://shareguard.systems` and verify the public
   response contains no private fields.
5. Stop the local inference, gateway, and tunnel; verify the site still works.

Rollback restores the existing Named Tunnel route. The local stack and its
scripts are retained until the cloud endpoint has passed a full competition
rehearsal.

## 9. Testing

Automated tests will cover:

- the Modal deployment contract, including GPU, scale-to-zero, volume mounts,
  secret injection, non-mock production mode, and model digest requirement;
- artifact upload commands that reject a missing or mismatched archive;
- Worker path, method, origin, header-scrubbing, streaming, and upstream-error
  behavior;
- repository scans proving no model artifact, credential, or live Modal origin
  is tracked;
- the existing 92 platform tests without regression.

Deployment verification will cover authenticated and unauthenticated readiness,
CORS preflight, one real image, response privacy, cold start, warm latency, and
operation after the laptop stack is stopped.

## 10. Success Criteria

The migration is complete only when all of the following are true:

- `shareguard.systems` performs a real analysis through
  `api.shareguard.systems` while the laptop services are stopped;
- unauthenticated requests receive `401` and disallowed origins receive `403`;
- a valid image receives the current product response contract;
- no private model field or file is present in the public response or Git
  history;
- the normal idle configuration scales the Modal GPU to zero;
- a documented warm command can hold one container for a scheduled demo;
- rollback to the existing tunnel is documented and tested without DNS
  redesign.

## 11. Non-Goals

This migration does not retrain, quantize, benchmark, or change the scientific
model. It does not add customer billing, multi-tenancy, a public developer API,
or a permanent always-on GPU. Those are later product phases after pilot usage
is measured.
