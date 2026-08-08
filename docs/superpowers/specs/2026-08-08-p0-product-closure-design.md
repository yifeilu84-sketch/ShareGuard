# ShareGuard P0 Product Closure Design

**Date:** 2026-08-08

## Scope

This release closes only the P0 product gaps around the existing protected
image-screening service. It does not deploy the private research checkpoint
and does not create a managed moderation API product.

The release must turn the current single-user evidence workbench into a real
case workflow without inventing capabilities that the image-level detector
does not possess. In particular, ShareGuard must never present reviewer boxes
as model localization, a generated transform as a recovered original, or a
declared source as an automatically verified propagation event.

## System Boundaries

The production system keeps three existing planes and adds private media
custody to the control plane:

1. The GitHub Pages workbench renders cases, real uploaded versions, reviewer
   collaboration, exports, and offline verification.
2. The Cloudflare Worker authenticates actors, owns workflow policy, creates
   scoped review grants, encrypts media, signs evidence, and mediates access to
   Durable Objects and a private R2 bucket.
3. The Durable Object stores case projections and the append-only event chain.
4. Modal remains a stateless image-level inference service and never owns case
   history or long-term media.

R2 objects have no public URL. Every object is encrypted by the Worker with
AES-256-GCM and a deployment secret before storage. Object names contain only
opaque actor, case, and version identifiers. Raw bytes are returned only to an
authorized case owner or an unexpired, case-scoped reviewer grant.

## Honest Forensics Contract

The live detector returns one score for the whole image. Therefore:

- `localization.available` remains false and the UI contains no machine boxes,
  fake heatmap, or location-specific machine claim;
- the forensic lens is a pixel magnifier and comparison tool, not an AI
  localization surface;
- all rectangular annotations carry `origin: human_reviewer` and an actor id;
- comparison is between two media versions actually supplied to the case;
- generated stress transforms are disabled on the formal site and are never
  labelled as observed propagation or reconstruction;
- any future attribution map requires a versioned method, validation artifact,
  and an explicit `model_sensitivity_not_localization` label.

Closing the localization gap in this release means removing the false product
claim and making the supported human forensic workflow complete. It does not
mean manufacturing unsupported pixel-level evidence.

## Case Workflow

Each case has a deterministic workflow projection:

- status: `awaiting_review`, `awaiting_source`, `escalated`, `held`,
  `closed_allowed`, or `sealed`;
- priority: `urgent`, `high`, `normal`, or `low`;
- an SLA due timestamp derived from priority;
- an optional assignee;
- open and completed tasks;
- comments and reviewer annotations;
- ordered media versions, provenance nodes, and provenance edges.

Ingest creates a review task. Human actions perform real transitions:

- `allow` resolves review tasks and closes the case;
- `request_original` creates a source-acquisition task;
- `escalate` creates a senior-review task;
- `hold` records a publication hold and creates a resolution task.

The radar is ordered by open state, priority, SLA breach, and update time. It
supports status/priority filtering, cursor pagination, assignment, and timed
refresh. Machine recommendations remain advisory and cannot close or hold a
case.

## Controlled Review

An owner may issue an expiring case-scoped grant with a reviewer display name,
role, and expiry. The signed token contains an opaque owner namespace, case id,
grant id, role, and expiry. It is passed in the URL fragment so it is not sent
as an HTTP referrer; the workbench moves it into an Authorization header held
only in page memory.

Reviewer grants may read one case, fetch its media, add comments, and create
human annotations. They cannot list other cases, delete, assign, change
priority, issue another grant, make the final decision, or seal. Every grant,
comment, and annotation is written to the event chain with the reviewer actor
id. Expired or revoked grants fail closed.

## Verifiable Provenance Graph

The graph is evidence-led rather than inferred from image appearance:

- every uploaded version is a media node with a SHA-256 digest;
- a source declaration creates a source node and a typed edge;
- an edge records relationship, capture time, URL/channel when supplied,
  evidence basis, actor, and verification state;
- an exact media digest match may be labelled `digest_verified`;
- all other reviewer assertions remain `declared_unverified`;
- missing or unsupported Content Credentials are reported as unavailable, not
  silently treated as valid.

No Telegram, WeChat, newsroom, or other channel node appears unless a reviewer
actually records it. The graph never infers a chain from pixels alone.

## Private Media Custody

After successful inference, the Worker validates the uploaded bytes against
the reported digest, creates opaque case/version ids, encrypts the media, and
stores it in private R2 before the case ingest is committed. If persistence
fails, the analysis request fails rather than returning an apparently tracked
success. A failed case commit causes best-effort object cleanup.

Media metadata records storage state, plaintext digest, MIME type, byte size,
encryption algorithm, key version, retention deadline, and object id. Default
retention is seven days. An owner may delete an unsealed case and its objects.
Sealing places included media under evidence hold; later retention and legal
hold administration are P1.

## `.sgd v3` Evidence Container

The server-signed payload schema is `shareguard.sgd.v3`. It includes the
immutable case snapshot, event chain, provenance graph, task/decision state,
and a media manifest. Media no larger than 8 MiB is embedded when private
custody is available; otherwise the manifest explicitly records detached
digest-only evidence.

The downloadable file is a binary ShareGuard container:

1. a small versioned header;
2. a gzip-compressed signed JSON payload;
3. optional browser-side AES-256-GCM encryption using a key derived with
   PBKDF2-SHA-256 from a handoff passphrase.

The passphrase never leaves the browser. Encryption is optional and the UI
must accurately distinguish `signed + compressed` from
`signed + compressed + encrypted`. The verifier decrypts locally, decompresses
the payload, verifies the pinned issuer signature and event chain, checks every
embedded media digest, and can compare an externally supplied file.

## API Additions

Owner-authenticated routes:

- `GET /v1/cases?status=&priority=&cursor=&limit=`
- `POST /v1/cases/{id}/workflow`
- `POST /v1/cases/{id}/comments`
- `POST /v1/cases/{id}/review-grants`
- `POST /v1/cases/{id}/review-grants/{grant_id}/revoke`
- `GET /v1/cases/{id}/versions/{version_id}/media`

A valid review token may use only:

- `GET /v1/review/case`
- `GET /v1/review/media/{version_id}`
- `POST /v1/review/comments`
- `POST /v1/review/annotations`

Existing analysis, provenance, decision, seal, and metrics routes remain. All
authorization context is injected by the Worker and ignored if supplied by a
client.

## Migration And Failure Behaviour

Existing cases are migrated on read by deriving workflow state, tasks, media
custody state, and graph nodes from their current fields. Existing `.sgd v2`
packages remain verifiable in legacy mode, while all new seals use v3.

- Missing R2 or media encryption configuration makes production readiness
  fail and blocks new tracked analyses.
- Missing review-token configuration blocks grant issuance but never weakens
  owner authentication.
- Media digest mismatch, decryption failure, missing objects, or incomplete
  case persistence fails closed with a non-sensitive error.
- Sealed cases remain immutable.
- Formal mode never substitutes a mock response, fixed annotation, generated
  provenance node, or reconstructed image.

## Acceptance Criteria

1. A real upload survives refresh and another authorized browser can retrieve
   the exact bytes from private custody with the same SHA-256 digest.
2. The radar orders urgent and SLA-breached work ahead of normal work and human
   actions create observable tasks and state transitions.
3. A case-scoped reviewer link expires, cannot access another case, and can add
   a comment or human annotation that appears in the audit chain.
4. The provenance graph contains only uploaded media and reviewer-supported
   edges with explicit verification states.
5. The comparison slider shows two real uploaded versions without stretching,
   reconstruction language, or generated stress-test claims.
6. A new `.sgd` embeds eligible media, verifies all digests and the pinned
   signature offline, and can be encrypted/decrypted locally with a passphrase.
7. No model weights, raw media, private keys, passwords, review tokens, R2
   credentials, or service origins enter Git.
8. Worker, Python, frontend-contract, desktop, mobile, and production E2E tests
   pass without fixed A1/A2 markers or fictitious topology.
