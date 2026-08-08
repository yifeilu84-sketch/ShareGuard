# ShareGuard Cloudflare Control Plane

This Worker provides the authenticated ShareGuard control plane: inference
proxying, per-client quotas, durable cases, hash-linked events, operational
metrics, trusted evidence sealing, and public trust-root metadata. It does not
persist uploaded media bytes.

## Secret Boundary

The following values are Cloudflare secrets and must never enter Git:

- `MODAL_ORIGIN`
- `EDGE_SHARED_SECRET`
- `EDGE_AUTH_HMAC`
- `SGD_SIGNING_PRIVATE_JWK`

The signing public key, key ID, issuer, rate limits, and allowed browser origin
are non-secret deployment configuration.

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
