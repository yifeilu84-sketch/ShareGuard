# ShareGuard V1.1 Production Frontend Hardening Design

## Objective

Move the interactive dossier from a polished product demonstration to a production-shaped frontend foundation without exposing private model assets or changing the existing product metaphor.

## Scope

The release adds six coordinated capabilities:

1. Mobile decision ergonomics: the existing release and seal actions remain reachable in a viewport-fixed action bar below 900 px, including iOS safe-area spacing and content clearance.
2. Touch forensics: mouse users retain a following lens; coarse-pointer users tap to lock a lens above the finger and tap again or press Escape to release it.
3. Evidence comparison affordance: the current split percentage controls a visible one-pixel divider and compact drag handle over the evidence viewport.
4. Rendering and sealing performance: the throughput trace uses `requestAnimationFrame`, cached canvas dimensions, `ResizeObserver`, visibility suspension, and reduced-motion fallback. Canonicalization, media hashing, optional media embedding, manifest hashing, and ECDSA signing move to a dedicated Worker.
5. Internationalization: a dependency-free `zh-CN` and `en` dictionary controls principal navigation, decisions, sample cases, actions, report copy, review copy, and accessibility labels. Locale persists locally and is sent as `Accept-Language` to the private API boundary.
6. Accessible restrained motion: verdict stamping, reticle locking, and machine-testimony decoding run once per state change, are cancellable, avoid repeated screen-reader announcements, and become instantaneous under reduced motion.

## Architecture

`i18n.js` owns locale state, dictionaries, DOM translation, persistence, and subscriptions. `dossier.js` consumes that API for dynamic product data and remains responsible for the workbench state. `crypto-worker.js` is a replaceable sealing provider: it accepts a plain manifest plus a transferable media buffer and returns a signed package contract. A main-thread Web Crypto fallback preserves compatibility while keeping the Worker as the normal path.

Files up to 8 MiB remain self-contained in `.sgd` packages. Larger files use detached-evidence mode: the signed manifest contains the original media SHA-256 and metadata but not a Base64 copy. The independent verifier accepts an optional original media file and validates it against the signed digest. This boundary leaves room for a future streaming/OPFS provider without changing the workbench API.

## Interaction Rules

- The mobile action bar appears only while the dossier view is active and never covers the final report controls.
- A touch scroll must not lock the forensic lens; only a low-movement tap may toggle it.
- The comparison divider is visual only. The range input remains the semantic and keyboard-operable control.
- Verdict and testimony animation must not replay on clocks, countdowns, or unrelated state updates.
- Language switching must not discard the uploaded file, active case, evidence view, review notes, or custody history.
- Worker errors time out and fall back to local Web Crypto with an explicit seal-log entry.

## Security And Privacy

- No model checkpoint, fusion coefficient, threshold, HPC path, signed artifact URL, or private API credential enters static assets.
- The browser key remains demonstrator-only and ephemeral. Production trust still requires the private ShareGuard root certificate service.
- Detached media verification is local; media never leaves the verifier page.
- Object URLs are revoked when replaced to avoid retaining uploaded media in browser memory.

## Verification

- Contract tests cover new assets, routes, CSP worker policy, i18n hooks, touch lock, rAF rendering, Worker sealing, detached verification, sticky actions, focus styles, split handle, and reduced motion.
- Existing backend and security tests remain green.
- Browser acceptance covers 1440 px desktop and 390 px mobile, touch lens lock, locale round trip, upload demo disclosure, seal/download/verify, detached-media prompt, no horizontal overflow, and zero console errors.

## Out Of Scope

Streaming video decoding, RAW rendering, OPFS persistence, resumable uploads, ZIP/binary `.sgd` containers, production certificate issuance, and model inference changes belong to the future heavy-media provider.
