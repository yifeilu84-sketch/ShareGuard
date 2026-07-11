# ShareGuard Interactive Dossier Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current SaaS-style ShareGuard page with a complete editorial evidence desk that supports threat triage, image examination, business decisions, evidence sealing, and offline verification without exposing the private model.

**Architecture:** Keep the existing Python inference API and model boundary unchanged. Split the static frontend into a small semantic HTML shell, a dedicated dossier design system, and a standalone interaction controller; add an allowlisted static-file route for those assets. Generate signed `.sgd` evidence manifests with Web Crypto and verify them in a separate static page.

**Tech Stack:** Semantic HTML, native CSS, vanilla JavaScript, Canvas 2D, Web Crypto API, Python standard-library HTTP server, `unittest`, Playwright.

## Global Constraints

- Use `#F7F5F0`, `#1A1A1A`, `#D32F2F`, `#D97706`, and `#2E7D32` as the only principal palette roles.
- Use no CSS gradients, decorative shadows, rounded cards, rounded controls, or decorative motion.
- Preserve `/api/analyze` and static-demo behavior; never expose model paths, internal thresholds, fusion coefficients, weights, or raw subgroup scores.
- Keep every primary control keyboard accessible with a visible focus state and at least a 44 px touch target.
- Respect `prefers-reduced-motion` and replace continuous motion with static state when requested.
- Keep the public repository package model-free and the GitHub Pages build functional.

---

### Task 1: Dossier Contract Tests

**Files:**
- Modify: `tests/test_platform_backend.py`
- Modify: `tests/test_platform_http.py`

**Interfaces:**
- Produces: structural, visual, interaction, and static-route contracts for subsequent tasks.

- [ ] Replace the legacy navy SaaS assertions with checks for `radarView`, `dossierView`, `reviewerView`, `forensicCanvas`, `compareRange`, `sealDialog`, and the dossier palette.
- [ ] Add assertions that the CSS contains no gradients or shadows and provides reduced-motion and responsive rules.
- [ ] Add assertions for `runSealingRitual`, `createEvidencePackage`, static fallback functions, report export functions, and the independent verifier.
- [ ] Add HTTP tests for `/dossier.css`, `/dossier.js`, `/verifier.html`, and `/verifier.js`.
- [ ] Run the focused tests and confirm they fail because the new files and contracts do not exist.

### Task 2: Static Shell and Design System

**Files:**
- Replace: `shareguard/platform/static/index.html`
- Create: `shareguard/platform/static/dossier.css`
- Modify: `shareguard/platform/app.py`

**Interfaces:**
- Consumes: existing `assets/flagship-event.jpg`.
- Produces: the radar, dossier, custody log, reviewer, drag overlay, and sealing dialog DOM surfaces.

- [ ] Build a compact top command bar with threat state, case identity, and view switches.
- [ ] Build the 75/25 radar inbox and quarantine layout.
- [ ] Build the 70/30 lightbox dossier with image stage, Canvas layer, comparison control, marginalia, verdict, provenance, and actions.
- [ ] Build the controlled reviewer state and custody log without backend navigation.
- [ ] Implement the zero-radius, one-pixel-line design system and responsive structural breakpoints.
- [ ] Serve the new static assets through an explicit allowlist in the Python handler.

### Task 3: Investigation Interaction Controller

**Files:**
- Create: `shareguard/platform/static/dossier.js`

**Interfaces:**
- Consumes: `/api/analyze`, uploaded JPEG/PNG/WebP files, static fallback data, and the DOM from Task 2.
- Produces: `switchView`, `loadSampleCase`, `renderCaseContext`, `selectEvidenceView`, `buildStaticDemoPayload`, `makeStaticPropagationViews`, and `buildStaticReport`.

- [ ] Implement view switching, quarantine-to-dossier transitions, live intercept updates, and countdowns.
- [ ] Implement full-window drag-and-drop, file metadata, API analysis, mock replacement, and GitHub Pages fallback.
- [ ] Implement the comparison slider, Canvas forensic lens, fixed anomaly callouts, and propagation-version switching.
- [ ] Render verdict-first business decisions, machine narrative, provenance topology, custody events, and report export actions.
- [ ] Implement force-release confirmation and asynchronous legal marginalia stored locally.

### Task 4: Evidence Sealing and Independent Verification

**Files:**
- Create: `shareguard/platform/static/verifier.html`
- Create: `shareguard/platform/static/verifier.js`

**Interfaces:**
- Produces: `createEvidencePackage(payload) -> Promise<object>` and a verifier that recomputes SHA-256 and validates an ECDSA signature.

- [ ] Generate a canonical evidence manifest containing case identity, media metadata, decision, provenance, and custody log.
- [ ] Hash the canonical payload with SHA-256, sign it with an ephemeral ECDSA P-256 key, and export the public JWK in the `.sgd` package.
- [ ] Show the sealing sequence in a terminal-style native dialog and expose the download only after signing completes.
- [ ] Build an offline verifier that reads `.sgd`, recomputes the digest, verifies the signature, and displays only verified dossier facts.
- [ ] Label browser signing as a demonstrator and reserve production root-certificate signing for the private service.

### Task 5: Public Surface and Verification

**Files:**
- Modify: `public_demo/index.html`
- Modify: `tests/test_platform_backend.py`

**Interfaces:**
- Produces: a model-free public dossier preview aligned with the main product visual language.

- [ ] Restyle the public package using the dossier palette and sharp evidence vocabulary while preserving the model-exclusion statements.
- [ ] Run `python -m unittest discover -s tests -v` and `git diff --check`.
- [ ] Start the local platform server and use Playwright at 1440x1000, 1024x768, and 390x844.
- [ ] Verify nonblank imagery, no overlap, keyboard focus, drag/upload states, dossier switching, sealing dialog, verifier loading, and reduced motion.
- [ ] Run the design detector, inspect final screenshots, and correct any high-severity visual or accessibility findings.
