# Live Model Disclosure

Status date: 2026-08-08

## Product Identity

The workbench displays **ShareGuard Protected Screening Engine**. This is the
name of the protected ShareGuard inference service and editorial workflow. It
does not state or imply that every detector weight used inside the service is
proprietary to ShareGuard.

ShareGuard owns and operates the policy layer, persistent case workflow,
human-decision gate, version handling, declared-source records, reviewer
annotations, hash-linked audit events, server-side evidence signing, offline
verification, reporting, and product interface.

## Current Live Detector

The temporary live image-level detector is SPAI: Spectral AI-Generated Image
Detector.

- Source: https://github.com/kartyg23/spai
- Pinned source revision: `b1b1422f2912594ba2620b311dde5d28a230d04c`
- Upstream license: Apache License 2.0
- Official checkpoint SHA-256: `24159f27d7c8c2cd0cb6c4019189eb89ad0874a0d9d15f8dc9afd39ca9648a55`
- Runtime safetensors SHA-256: `ac5caaa6457172c53e36acdf665051ff292d2c3906b3911c51ed5db6844c2f87`

The runtime tensor artifact is stored in a protected Modal volume and is not
committed to GitHub. The ShareGuard private fusion model is **not deployed**,
and no private-model shadow evaluation is active in the current service.

## Output Meaning

The detector returns an **uncalibrated screening score**, not a factual
probability that an image is AI-generated. The ShareGuard decision layer turns
that signal into an advisory machine recommendation. A structured human
decision is the formal case disposition.

The temporary detector is image-level only. It does not provide pixel-level
localization or a verified transmission history. Any boxes shown in a persisted
case are human reviewer annotations. Source channel, URL, capture time, and
notes entered by a reviewer are labelled `DECLARED / UNVERIFIED`.

## Data Boundary

Uploaded bytes are processed by the protected inference service and, for new
production cases, encrypted with AES-256-GCM before being stored in a private
Cloudflare R2 bucket. The media-encryption key is a Worker secret and is not
stored in Git, R2, the Durable Object, or the browser. The durable case record
retains the plaintext media SHA-256, image metadata, custody metadata, results,
human actions, and hash-linked audit events.

Authorized owners and unexpired case-scoped reviewers can retrieve the
decrypted bytes through the Worker. The browser recomputes SHA-256 and refuses
to display a response that does not match the case version. R2 objects are not
public and are deleted when an unsealed case is deleted. Historical records
created before encrypted custody may remain `detached_digest_only`; those can
be viewed as records and can use a locally reattached digest-matching file.

## Research Result Boundary

Benchmark tables and competition materials describing the ShareGuard private
fusion model are research results. They must not be interpreted as performance
measurements of an individual request served by the temporary live detector.
The managed third-party platform API product is outside the current deployment
scope.
