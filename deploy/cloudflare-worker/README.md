# ShareGuard Cloudflare Control Plane

This Worker provides the authenticated ShareGuard control plane: inference
proxying, per-client quotas, durable cases, hash-linked events, operational
metrics, workflow state, scoped review access, encrypted private-media custody,
trusted evidence sealing, and public trust-root metadata. Uploaded media is
encrypted with AES-256-GCM before it is written to the private R2 bucket; the
Durable Object case record stores custody metadata and the plaintext SHA-256,
not plaintext media bytes.

## Secret Boundary

The following values are Cloudflare secrets and must never enter Git:

- `MODAL_ORIGIN`
- `EDGE_SHARED_SECRET`
- `EDGE_AUTH_HMAC`
- `SGD_SIGNING_PRIVATE_JWK`
- `MEDIA_ENCRYPTION_KEY_B64`
- `REVIEW_TOKEN_SECRET`
- `MEDIA_DECRYPTION_KEYS_JSON` when retained objects use an older media key

The signing public key, key ID, issuer, rate limits, and allowed browser origin
are non-secret deployment configuration.

Private-media cost protection is enforced by the singleton `STORAGE_QUOTA`
Durable Object. Production permits at most 100 new media reservations per UTC
day and 8,000,000,000 active bytes across the seven-day retention window. A
missing binding or invalid limit fails readiness and media ingestion closed.
The quota is released only after an R2 deletion is confirmed; ambiguous cleanup
remains counted until confirmed recovery or deletion. Retention expiry alone
does not lower the ledger because R2 lifecycle processing is asynchronous.

Create the bucket with Standard storage and install the matching seven-day
expiration rule before deploying production:

```powershell
npx wrangler r2 bucket create shareguard-private-media --storage-class Standard
npx wrangler r2 bucket lifecycle add shareguard-private-media shareguard-seven-day-expiry --expire-days 7
npx wrangler r2 bucket lifecycle list shareguard-private-media
```

Do not add an Infrequent Access transition. The Worker ledger deliberately keeps
20% headroom below the 10 GB Standard-storage free tier, and the daily object
cap keeps write operations far below the included request allowance.

## Generate And Install A Signing Key

Generate the private key outside the repository. This command refuses to
overwrite either output file:

```powershell
$Private = Join-Path $env:LOCALAPPDATA "ShareGuard\secrets\sgd-signing-2026-01-private.jwk"
$Public = Join-Path $env:TEMP "sgd-signing-2026-01-public.jwk"
node .\scripts\generate-signing-key.mjs --private-out $Private --public-out $Public
```

Review the public JWK only. Put that public value in
`SGD_SIGNING_PUBLIC_JWK` in `wrangler.toml`, and pin the same issuer, key ID,
algorithm, and public JWK in
`shareguard/platform/static/runtime-config.js`. Never paste the private JWK
into either file.

Install the private JWK without printing it:

```powershell
Get-Content -Raw -LiteralPath $Private | npx wrangler secret put SGD_SIGNING_PRIVATE_JWK
```

Install the remaining runtime secrets with `wrangler secret put`, then run:

```powershell
npm test
npx wrangler deploy
```

Verify `/v1/trust-root` returns the expected public key ID before issuing a
production package.

## Private Media And Review Access

Production requires the R2 bucket configured as `MEDIA_BUCKET` and a 32-byte
base64 media-encryption key in `MEDIA_ENCRYPTION_KEY_B64`. The key version is
recorded in custody metadata. Before rotating the current key, install a secret
JSON object in `MEDIA_DECRYPTION_KEYS_JSON` that maps every retained historical
key version to its base64 key; then update the current key and version together.
The historical keyring is used for decryption only. `MEDIA_CUSTODY_REQUIRED=true`
causes analysis to fail closed if encrypted persistence cannot be completed.

Adding media to an existing case uses an opaque Durable Object ingest
reservation before the Worker writes R2. A successful case commit consumes the
reservation atomically. If case persistence fails and immediate R2 cleanup also
fails, the reservation becomes `cleanup_required` and remains part of the case
custody state. Active reservations block sealing and deletion. Before sealing,
the Worker removes every `cleanup_required` object and releases its reservation;
the Durable Object checks the reservation set again in the sealing transaction.
Cleanup always marks the reservation before deleting R2. If an ingest commit
succeeds but its response is lost, the same settlement route reports the
committed version and the Worker preserves the referenced object.
If even the reservation-settlement response is lost, an authenticated owner can
call `POST /v1/cases/{case_id}/ingest-recovery`. The Worker reconciles every
incomplete reservation, deletes only media proven uncommitted, and returns the
refreshed case. Review tokens cannot invoke this route.

Unsealed case deletion uses a retry-safe two-phase protocol. The Durable Object
first freezes the case and records one hash-linked deletion plan. The Worker
then deletes every planned R2 object and commits the metadata deletion with the
same opaque deletion ID. R2 failure leaves the frozen plan available for retry;
a lost commit response is resolved through a minimal tombstone that contains no
media or case content. Direct internal case deletion is rejected.

Case owners can issue expiring reviewer grants. Review tokens are HMAC signed
with `REVIEW_TOKEN_SECRET`, are restricted to one owner and one case, and are
placed in the URL fragment so they are not sent as a normal page URL. A scoped
reviewer can read that case and its protected media and can add comments and
human annotations. Owner routes, other cases, workflow changes, decisions,
sealing, and deletion remain unavailable. Revocation is checked against the
current case record on every scoped request.

The formal site compares only media versions that were actually uploaded into
the case. It never turns a generated transform into an observed propagation
event, a verified provenance node, or a reconstructed original.

## SGD v3 Evidence

The seal route produces a server-signed ShareGuard Evidence Package v3. It
contains the immutable case snapshot, event chain, workflow and task state,
provenance graph, media manifest, and eligible embedded media. The browser may
add local passphrase encryption with AES-GCM and PBKDF2 after receiving the
signed package. The static verifier supports v3 and retained legacy v2 packages.

## Key Rotation

For planned **rotation**:

1. Generate a new key pair with a new monotonically named key ID.
2. Add the new public root to `runtime-config.js` while retaining the old root.
3. Deploy the static verifier first so both roots are trusted.
4. Update the Worker public key and key ID, install the matching private secret,
   and deploy the Worker.
5. Seal and independently verify a canary case.
6. Retain the old public root for the evidence-retention period.

## Emergency Revocation

For emergency **revocation**, stop new signing first:

```powershell
npx wrangler secret delete SGD_SIGNING_PRIVATE_JWK
```

Generate a replacement key, remove the compromised public root from
`runtime-config.js`, and redeploy the verifier and Worker. Previously issued
packages from the removed key will become untrusted by current policy; preserve
the incident record and do not rewrite package history.

## Rollback

A code **rollback** must keep Durable Object data intact. Redeploy the last
known-good Worker commit with the matching active key ID and public JWK. Do not
delete Durable Object migrations or case storage. If the signing key itself is
suspect, use the revocation procedure instead of restoring it.

## Release Check

Before every deployment:

```powershell
git diff --cached --check
git diff --cached --name-only
git grep -n -E "BEGIN (EC |RSA )?PRIVATE KEY|SGD_SIGNING_PRIVATE_JWK=.*\{|Authorization: Basic"
npm test
```

The grep command should find only documentation or variable names, never a key
value, credential, private model path, or private upstream origin. Confirm that
model archives, `.env` files, private JWK files, and generated evidence packages
remain untracked.
