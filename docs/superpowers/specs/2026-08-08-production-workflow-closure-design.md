# ShareGuard Production Workflow Closure Design

**Date:** 2026-08-08

## Purpose

Turn the current single-image screening demo into a persistent, auditable
editorial workflow while keeping GPU inference stateless and private. The
managed third-party API product (batch jobs, SDKs, webhooks, tenant billing,
and platform onboarding) remains out of scope.

The temporary detector may use a licensed third-party checkpoint behind the
protected service boundary. Product surfaces may use the neutral service name
`ShareGuard Protected Screening Engine`, but must not claim that third-party
weights are proprietary or self-developed. Accurate provenance and license
information remains in the repository model disclosure and third-party notice.

## Architecture

The system has three clear layers:

1. The static ShareGuard workbench on GitHub Pages handles media preview,
   reviewer interaction, exports, and offline verification.
2. The Cloudflare Worker is the authenticated control plane. It enforces
   quotas, owns persistent case state in a Durable Object, creates the
   append-only event chain, signs sealed evidence packages, and exposes
   operational metrics.
3. Modal is the stateless GPU inference plane. It validates an image, runs the
   configured detector, and returns a sanitized screening result. It never
   stores case history or original media.

No raw image bytes are stored by the Worker or Durable Object. A case stores
only file metadata, SHA-256 digests, detector outputs, reviewer records,
declared provenance, and human annotations.

## Product Identity And Disclosure

- Normal product UI: `ShareGuard Protected Screening Engine` /
  `ShareGuard 受保护筛查引擎`.
- Normal product UI does not expose a checkpoint or upstream repository name.
- Normal product UI does not describe temporary third-party weights as a
  proprietary model.
- `THIRD_PARTY_NOTICES.md` and `docs/model-disclosure.md` state the exact
  detector source, pinned revision, checkpoint digest, license, and role.
- ShareGuard-owned components are named explicitly: decision policy, case
  workflow, evidence chain, sealing profile, verifier, and product UI.

## Case Model

Each authenticated client owns an isolated case namespace. A case contains:

- `case_id`, title, status, created/updated/sealed timestamps;
- one or more versions with role `original`, `observed_variant`, or
  `generated_stress_test`;
- sanitized inference result, request id, latency, model release id, media
  digest, dimensions, and score semantics for each version;
- source declarations entered by the reviewer, explicitly marked `declared`
  rather than machine-verified;
- reviewer-created rectangular annotations with normalized coordinates;
- a structured human decision and optional confirmation feedback;
- an append-only, hash-linked event list;
- an optional signed sealing record.

The service rejects edits after sealing. Deleting a case is allowed only before
sealing. Raw media remains in browser memory and is discarded on navigation or
refresh.

## Decision Semantics

The detector output is a screening score, not a factual probability. Until a
versioned calibration artifact is deployed, the API returns:

- `score_kind: uncalibrated_ai_generation_score`;
- `calibration.status: unavailable`;
- no percentage-style probability claim;
- a conservative `review` recommendation for high or ambiguous scores.

Only a human decision can set `allow`, `request_original`, `escalate`, or
`hold`. Every human decision requires a reason code. Free text is optional for
routine reasons and mandatory for `other`.

When a validated calibration artifact is later configured, the same schema can
return a calibrated estimate, artifact digest, dataset id, sample count, and
validation metrics without changing the workbench contract.

## Persistent Workflow API

All routes require the existing edge authentication except `/v1/health`, which
returns only non-sensitive gateway state.

- `POST /v1/analyze`: proxy one image to Modal, create or extend a case, and
  return the persisted case and version identifiers.
- `GET /v1/cases`: list the current client's cases without media bytes.
- `GET /v1/cases/{case_id}`: return the full case record.
- `POST /v1/cases/{case_id}/decision`: record a structured human decision.
- `POST /v1/cases/{case_id}/annotations`: replace reviewer annotations for one
  version and append an audit event.
- `POST /v1/cases/{case_id}/provenance`: record declared source information.
- `POST /v1/cases/{case_id}/feedback`: record confirmed-real,
  confirmed-generated, or unresolved outcome with evidence basis.
- `POST /v1/cases/{case_id}/seal`: freeze the case and return a signed `.sgd`
  package.
- `DELETE /v1/cases/{case_id}`: delete an unsealed case.
- `GET /v1/metrics`: return operational counts, decision distribution,
  disagreement feedback, latency, score distribution, and drift-signal state.
- `GET /v1/trust-root`: return the active public signing key and key id.
- `GET /v1/health`: return gateway and case-store configuration state without
  waking the GPU.
- `GET /v1/ready`: retain the explicit GPU readiness check.

There are no public batch, webhook, billing, or tenant API routes.

## Event Chain

Every event has a monotonic sequence, timestamp, server-derived actor id,
event type, payload, previous hash, and event hash. The hash is SHA-256 over
canonical JSON containing all preceding fields. The first event uses 64 zeroes
as its previous hash.

Events include case creation, version analysis, provenance update, annotation
update, human decision, feedback, and sealing. Existing events are never
modified. Case projections may change, but the event chain is the audit source
of truth included in every sealed package.

## Evidence Package And Trust

Evidence package schema `shareguard.sgd.v2` contains the immutable case
snapshot, event chain, chain head, issuer, signing key id, signed timestamp,
and signature. The Worker signs canonical JSON with an ECDSA P-256 private key
stored only as a Cloudflare secret.

The verifier does not trust a public key carried inside a package. It verifies
against a pinned allowlist shipped with the formal site and reports separately:

- package schema validity;
- event-chain validity;
- signature validity;
- issuer/key trust;
- media digest match when the original file is supplied locally.

Unknown keys and browser-generated keys are untrusted, even if their
cryptographic signatures are internally valid.

## Propagation And Local Evidence

Observed reposts, screenshots, and recompressed copies are uploaded by the
reviewer as additional case versions. Generated stress-test derivatives are
permitted only when clearly labelled `generated_stress_test`; they are never
presented as observed propagation history.

The temporary image-level detector does not provide pixel localization. The
workbench therefore supports real reviewer annotations and labels them as
human annotations. It must not display pre-baked A1/A2 boxes or imply machine
localization. Declared source links and timestamps are similarly labelled as
reviewer-supplied and not independently verified.

## Monitoring And Feedback

The case store maintains privacy-minimized aggregates:

- cases and analyzed versions;
- model recommendations and final human decisions;
- override/disagreement count;
- confirmed-real and confirmed-generated feedback;
- mean and percentile latency;
- score histogram and a distribution-shift signal.

The drift signal is `insufficient_data` until a minimum sample count is met.
It is a score-distribution alert, not a claim of accuracy degradation. No raw
media or reviewer note text is included in metrics.

## Security And Failure Behaviour

- Existing Basic edge authentication, HMAC edge identity, CORS allowlist,
  upload limits, and rate quotas remain enforced.
- Case ids are random and validated; Durable Object namespaces are separated by
  authenticated client id.
- User-provided text is length-limited and rendered with `textContent`.
- Worker error responses never expose Modal origin, secrets, stack traces, or
  signing key material.
- Sealing fails closed when signing configuration is missing or invalid.
- Persistence failure does not return an untracked successful analysis.
- Inference failure creates no version event.
- The formal site rejects mock responses and never substitutes canned results.

## Acceptance Criteria

1. A user can upload an original and at least one observed variant into one
   persistent case, refresh, and reopen it.
2. A reviewer can add source declarations and image annotations; both survive
   refresh and appear in the audit chain.
3. A reviewer can record a reasoned final decision; a machine score alone never
   becomes a final hold.
4. The server returns a signed `.sgd` package, and the offline verifier accepts
   only a pinned ShareGuard issuer key.
5. HTML, JSON, print/PDF, and `.sgd` exports contain the same case id, media
   digests, engine release, machine recommendation, human decision, and chain
   head.
6. The monitoring view reports real persisted aggregates and clearly marks
   insufficient drift data.
7. No repository file contains model weights, private signing keys, passwords,
   Modal origin, or other deployment secrets.
8. Desktop and mobile production workflows pass automated tests and visual
   checks without demo annotations or fixed evidence output.
