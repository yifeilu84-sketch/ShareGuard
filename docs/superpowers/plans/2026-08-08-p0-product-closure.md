# ShareGuard P0 Product Closure Implementation Plan

**Goal:** Close the P0 workflow, collaboration, provenance, private-media, and evidence-container gaps without fabricating detector capabilities.

**Architecture:** Extend the existing Cloudflare Worker and Durable Object as the authenticated control plane, add an application-encrypted private R2 media store, keep Modal stateless, and make the browser workbench consume only persisted case data. New evidence packages remain server signed and are compressed and optionally passphrase-encrypted in the browser.

**Tech stack:** Cloudflare Workers, Durable Objects, R2, Web Crypto, vanilla JavaScript, Python/Pillow, Node test runner.

## Task 1: Workflow state machine and triage queue

- Add failing Durable Object tests for workflow migration, priority ordering, SLA state, assignments, tasks, and action transitions.
- Implement the workflow projection and owner-only workflow command.
- Add filtered cursor pagination and preserve compatibility for existing cases.
- Run Worker tests and commit.

## Task 2: Private media custody

- Add failing tests for AES-GCM storage, digest validation, authorization metadata, retrieval, and deletion cleanup.
- Implement `media-store.js`, R2 configuration, retention metadata, and fail-closed readiness.
- Persist encrypted bytes before committing analysis ingest and expose authorized media retrieval.
- Run Worker and deployment tests and commit.

## Task 3: Scoped review collaboration

- Add failing tests for signed token issue/expiry/revocation, case isolation, reviewer permissions, comments, and reviewer annotations.
- Implement grant routes and restricted review routes without weakening owner authentication.
- Store comments, grants, and collaboration events in the hash-linked chain.
- Run Worker tests and commit.

## Task 4: Evidence-led provenance and real comparison

- Add failing tests for media graph nodes, typed edges, declared and digest-verified states, and rejection of unsupported verification claims.
- Implement the provenance graph projection and migration from legacy declarations.
- Replace generated/reconstructed comparison language with actual uploaded-version comparison.
- Run Worker and frontend contract tests and commit.

## Task 5: `.sgd v3` container

- Add failing tests for signed v3 manifests, eligible media embedding, detached mode, gzip framing, optional AES-GCM/PBKDF2 encryption, and legacy v2 verification.
- Extend server sealing to retrieve and bind private media.
- Implement a shared browser container codec and update the offline verifier.
- Run Worker, browser contract, and verifier tests and commit.

## Task 6: Production workbench closure

- Add failing frontend contract tests for real queue controls, task state, review grants, comments, provenance graph, media retrieval, and truthful forensic labels.
- Wire the workbench to all new APIs and remove stale fixed or generated presentation paths.
- Verify desktop/mobile layouts, keyboard focus, image containment, and loading/error states.
- Run Python and browser tests and commit.

## Task 7: Deployment and production acceptance

- Update Cloudflare configuration, release documentation, privacy copy, and promotional source claims.
- Create the private R2 bucket and install generated secrets without printing or committing them.
- Deploy Worker and static site, then run live owner, reviewer, media, decision, sealing, encrypted verifier, refresh, and deletion tests.
- Run source-leakage checks, `git diff --check`, and final security review before merging to `main`.
