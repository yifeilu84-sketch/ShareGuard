# ShareGuard V1.1 Production Frontend Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the ShareGuard interactive dossier for mobile decision work, smooth rendering, large-media-safe sealing, bilingual operation, accessibility, and restrained forensic motion.

**Architecture:** Keep the dependency-free static workbench, add a standalone locale service and replaceable crypto Worker, and preserve the current backend/public API boundary. The Worker signs either an embedded small-media manifest or a detached large-media manifest, while the verifier supports both contracts.

**Tech Stack:** HTML5, CSS, browser Web Crypto, Web Workers, Canvas 2D, vanilla JavaScript, Python `unittest`, Playwright CLI.

## Global Constraints

- Preserve the dossier visual system: `#f7f5f0`, `#1a1a1a`, risk red, one-pixel rules, zero gradients, zero shadows, zero border radii.
- Do not expose private model artifacts, parameters, paths, credentials, or artifact digests.
- Respect `prefers-reduced-motion` and WCAG 2.2 keyboard focus visibility.
- Keep the public static build usable from `file:` and GitHub Pages.
- Keep existing `.sgd` packages verifiable.

---

### Task 1: Lock The V1.1 Contract

**Files:**
- Modify: `tests/test_platform_backend.py`
- Modify: `tests/test_platform_http.py`

**Interfaces:**
- Consumes: existing static-page and HTTP route test helpers.
- Produces: failing assertions for `i18n.js`, `crypto-worker.js`, Worker CSP, mobile action behavior, touch locking, rAF rendering, motion hooks, and detached verification.

- [ ] Add focused static-contract and route assertions.
- [ ] Run the focused tests and confirm they fail because the assets and behaviors do not exist.

### Task 2: Add Locale And Worker Boundaries

**Files:**
- Create: `shareguard/platform/static/i18n.js`
- Create: `shareguard/platform/static/crypto-worker.js`
- Modify: `shareguard/platform/app.py`
- Modify: `shareguard/platform/static/index.html`
- Modify: `shareguard/platform/static/verifier.html`

**Interfaces:**
- Consumes: `window.localStorage`, `postMessage`, transferable `ArrayBuffer`, Web Crypto.
- Produces: `window.ShareGuardI18n.{t,setLocale,apply,subscribe,getLocale}` and Worker `{type: "seal", requestId, manifest, mediaBuffer, embedMedia}` -> `{success, manifest, digest, signature, public_key}`.

- [ ] Serve both assets and explicitly permit same-origin Workers in CSP.
- [ ] Add bilingual DOM hooks, language control, comparison indicator, and detached-media verifier input.
- [ ] Implement dictionaries, persistence, stable canonicalization, media hashing, optional embedding, and ECDSA signing.
- [ ] Run focused tests until the asset and contract tests pass.

### Task 3: Harden Workbench Runtime

**Files:**
- Modify: `shareguard/platform/static/dossier.js`

**Interfaces:**
- Consumes: `ShareGuardI18n`, `crypto-worker.js`, the existing analysis payload, `File`/`Blob` media.
- Produces: visibility-aware rAF radar rendering, object-URL uploads, touch lens state, localized rendering, cancellable testimony decoding, Worker-first sealing, and main-thread fallback.

- [ ] Replace the fixed radar interval with cached rAF rendering and visibility suspension.
- [ ] Add tap-without-drag lens locking and Escape release.
- [ ] Localize dynamic cases, decisions, actions, review text, and API language headers without resetting state.
- [ ] Move seal canonicalization/hash/sign work to the Worker and preserve a fallback.
- [ ] Keep small packages embedded and mark large packages detached at 8 MiB.
- [ ] Run JavaScript syntax checks and focused contract tests.

### Task 4: Add Production Interaction Styling

**Files:**
- Modify: `shareguard/platform/static/dossier.css`

**Interfaces:**
- Consumes: `.stamp-enter`, `.lens-enter`, `[data-lens-locked]`, `.split-indicator`, and the existing `.decision-actions`.
- Produces: safe-area mobile actions, visible split affordance, high-contrast focus, and reduced-motion-safe forensic animation.

- [ ] Add fixed mobile action treatment with document clearance.
- [ ] Add split line/handle and touch lens states.
- [ ] Add verdict, reticle, and decoding motion without gradients, shadows, or radii.
- [ ] Strengthen quarantine and evidence-version focus states.
- [ ] Run design-contract tests and the anti-pattern detector.

### Task 5: Extend Independent Verification

**Files:**
- Modify: `shareguard/platform/static/verifier.js`

**Interfaces:**
- Consumes: signed manifest `media.sha256`, `media.embedded`, optional `media.data_url`, and user-selected detached media.
- Produces: package-signature verification plus local detached-media digest verification.

- [ ] Preserve legacy embedded package behavior.
- [ ] Prompt for detached media only after the package signature is valid.
- [ ] Hash and compare the selected original without uploading it.
- [ ] Render distinct verified, media-required, and rejected states.
- [ ] Run syntax and contract tests.

### Task 6: End-To-End Acceptance

**Files:**
- Modify only if acceptance uncovers a regression.

**Interfaces:**
- Consumes: local mock server, browser workbench, `.sgd` verifier.
- Produces: verified V1.1 release evidence.

- [ ] Run all Python tests and both JavaScript syntax checks.
- [ ] Scan changed public files for private artifacts and secrets.
- [ ] Verify desktop upload, language switching, touch simulation, seal/download/verify, mobile safe-area layout, no overflow, and no console errors in Playwright.
- [ ] Close all acceptance browser sessions while leaving the local server available.
