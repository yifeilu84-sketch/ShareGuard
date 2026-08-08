# ShareGuard Production Workflow Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persistent, auditable ShareGuard editorial workflow around a protected temporary detector without implementing the managed platform API product.

**Architecture:** Keep Modal as a stateless image inference plane and move case persistence, audit chaining, signing, and aggregate monitoring into a Cloudflare Durable Object. The GitHub Pages workbench consumes this authenticated control-plane API, stores no durable case state locally, and verifies signed evidence only against pinned ShareGuard trust roots.

**Tech Stack:** Python 3.11, Pillow, Node.js test runner, Cloudflare Workers, Durable Objects, Web Crypto ECDSA P-256, vanilla HTML/CSS/JavaScript.

## Global Constraints

- No raw image bytes may be persisted by Cloudflare or Modal.
- No model weights, private signing keys, credentials, or Modal origin may enter Git.
- Product UI must use `ShareGuard Protected Screening Engine` and must not claim that temporary third-party weights are proprietary.
- The formal site must reject mock/static inference output.
- Machine output is advisory; only a structured human decision is final.
- Managed batch APIs, SDKs, webhooks, tenant billing, and platform onboarding are out of scope.
- Every new behavior follows a failing-test-first red/green cycle.

---

### Task 1: Honest Inference And Decision Contract

**Files:**
- Modify: `shareguard/platform/service.py`
- Modify: `shareguard/platform/config.py`
- Modify: `tests/test_platform_service.py`
- Modify: `tests/test_platform_config.py`

**Interfaces:**
- Produces: `media_sha256`, `engine_release`, `policy`, and `calibration` fields in the sanitized analysis response.
- Produces: a conservative machine recommendation that never represents an uncalibrated score as a percentage probability or final human hold.

- [ ] Write failing service tests for media digest, neutral engine identity, calibration-unavailable metadata, and high-score review recommendation.
- [ ] Run the focused tests and confirm they fail for missing fields or old hold behavior.
- [ ] Add SHA-256 input digesting, policy metadata, corrected UTF-8 copy, and conservative decision logic.
- [ ] Run focused tests and the complete Python suite.
- [ ] Commit the contract change.

### Task 2: Durable Case Store And Audit Chain

**Files:**
- Create: `deploy/cloudflare-worker/src/case-store.js`
- Modify: `deploy/cloudflare-worker/src/index.js`
- Modify: `deploy/cloudflare-worker/test/index.test.js`
- Create: `deploy/cloudflare-worker/test/case-store.test.js`
- Modify: `deploy/cloudflare-worker/wrangler.toml`
- Modify: `deploy/cloudflare-worker/wrangler.preview.toml`

**Interfaces:**
- Produces: `ShareGuardCaseStore` Durable Object and canonical event hashing.
- Produces: authenticated case list/get/delete, decision, annotation, provenance, feedback, and metrics routes.
- Consumes: the analysis contract from Task 1.

- [ ] Write failing unit tests for canonical JSON, hash-linked events, sealed immutability, validation, and metrics.
- [ ] Write failing gateway tests for route/method allowlists and client-isolated case calls.
- [ ] Implement the Durable Object projection and event source with strict payload limits.
- [ ] Make successful `/v1/analyze` responses persist a version before returning to the browser.
- [ ] Add Durable Object bindings and a migration tag.
- [ ] Run all Worker tests.
- [ ] Commit the persistent workflow.

### Task 3: Server Signing And Pinned Trust

**Files:**
- Create: `deploy/cloudflare-worker/src/evidence.js`
- Create: `deploy/cloudflare-worker/test/evidence.test.js`
- Modify: `deploy/cloudflare-worker/src/index.js`
- Modify: `shareguard/platform/static/verifier.js`
- Modify: `shareguard/platform/static/verifier.html`
- Modify: `shareguard/platform/static/runtime-config.js`
- Modify: `tests/test_production_frontend_contract.py`

**Interfaces:**
- Produces: `shareguard.sgd.v2`, `canonicalJson(value)`, `signEvidence(snapshot, env)`, `/v1/trust-root`, and `/v1/cases/{id}/seal`.
- Produces: verifier states `valid_trusted`, `valid_untrusted`, `invalid_signature`, `invalid_chain`, and `media_mismatch`.

- [ ] Write failing Web Crypto tests proving a package signed by the active key verifies and an attacker-supplied package key is ignored.
- [ ] Write failing frontend contract tests forbidding self-signed browser packages in formal mode.
- [ ] Implement ECDSA P-256 secret import, canonical signing, trust-root publication, and fail-closed configuration checks.
- [ ] Update the verifier to use pinned roots and verify the event chain and optional local media digest.
- [ ] Run Worker and frontend contract tests.
- [ ] Commit trusted sealing.

### Task 4: Persistent Workbench Data Layer

**Files:**
- Create: `shareguard/platform/static/api-client.js`
- Modify: `shareguard/platform/static/index.html`
- Modify: `shareguard/platform/static/dossier.js`
- Modify: `shareguard/platform/static/dossier.css`
- Modify: `shareguard/platform/static/i18n.js`
- Modify: `shareguard/platform/app.py`
- Modify: `tests/test_platform_http.py`
- Modify: `tests/test_production_frontend_contract.py`

**Interfaces:**
- Produces: `ShareGuardApi` methods for analyze, list/get/delete cases, decision, annotations, provenance, feedback, seal, metrics, health, and trust root.
- Consumes: case and evidence APIs from Tasks 2 and 3.

- [ ] Write failing static-route and source-contract tests for the API client and case persistence behavior.
- [ ] Serve the API client with the production CSP.
- [ ] Replace sample-case and global-localStorage state with server case state.
- [ ] Add loading, empty, offline, quota, sealed, and persistence-error states.
- [ ] Keep uploaded image object URLs memory-only and revoke them on replacement.
- [ ] Run Python and frontend contract tests.
- [ ] Commit the persistent client layer.

### Task 5: Review, Versions, Provenance, And Annotations

**Files:**
- Modify: `shareguard/platform/static/index.html`
- Modify: `shareguard/platform/static/dossier.js`
- Modify: `shareguard/platform/static/dossier.css`
- Modify: `shareguard/platform/static/i18n.js`
- Modify: `tests/test_production_frontend_contract.py`

**Interfaces:**
- Produces: observed-version upload, clearly-labelled generated stress views, declared source records, reviewer annotations, reasoned human decision, and confirmation feedback.

- [ ] Write failing source-contract tests that forbid fixed A1/A2 annotations and require human annotation and declared-provenance labels.
- [ ] Build a multi-version case rail with explicit role labels and per-version results.
- [ ] Add normalized click-and-drag annotation editing with keyboard deletion and text notes.
- [ ] Add source channel, URL, capture time, and source-note fields labelled as reviewer declarations.
- [ ] Add structured human decision and feedback dialogs with required reason validation.
- [ ] Make sealing unavailable until a human decision exists.
- [ ] Run contract tests and manual keyboard checks.
- [ ] Commit the complete review workflow.

### Task 6: Consistent Exports And Monitoring

**Files:**
- Modify: `shareguard/platform/static/dossier.js`
- Modify: `shareguard/platform/static/index.html`
- Modify: `shareguard/platform/static/dossier.css`
- Modify: `shareguard/platform/static/i18n.js`
- Modify: `tests/test_production_frontend_contract.py`

**Interfaces:**
- Produces: one canonical case export view used by HTML, print/PDF, JSON, and `.sgd` download.
- Produces: a real operational dashboard backed by `/v1/metrics`.

- [ ] Write failing contract tests for required export fields and removal of synthetic queue traffic.
- [ ] Render case id, media hashes, engine release, machine recommendation, human decision, trust state, and event-chain head in every export.
- [ ] Download server-signed `.sgd` bytes without local re-signing.
- [ ] Build real case counts, decisions, overrides, feedback, latency, and score-shift status from persisted metrics.
- [ ] Label insufficient drift data and unavailable calibration without decorative placeholder numbers.
- [ ] Run contract tests.
- [ ] Commit export and monitoring parity.

### Task 7: Deployment Disclosure, Security, And End-To-End Verification

**Files:**
- Create: `docs/model-disclosure.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `README.md`
- Modify: `deploy/MODAL_SERVERLESS.md`
- Modify: `deploy/cloudflare-worker/README.md` if present, otherwise create it.
- Modify: `tools/check_source_leakage.py`
- Modify: `tests/test_deployment_contract.py`

**Interfaces:**
- Produces: key-generation and secret-install instructions, model disclosure, rollback procedure, and no-secret release checklist.

- [ ] Write failing deployment tests for required disclosure and forbidden private-key patterns.
- [ ] Document exact temporary detector provenance and the neutral product naming rule.
- [ ] Document ECDSA key generation, Cloudflare secret installation, public-key pinning, rotation, and emergency revocation.
- [ ] Run Python, Worker, source-leakage, and packaging tests.
- [ ] Start the local site and use Playwright at desktop and mobile widths to test upload fixture, reopening, annotations, decision, sealing, verifier, and metrics.
- [ ] Inspect screenshots for overlap, clipping, stale demo content, and inaccessible focus states.
- [ ] Run `git diff --check`, inspect `git status`, and commit the verified release candidate.
