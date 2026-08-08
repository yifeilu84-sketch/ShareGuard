# R2 Free-Tier Hard Limit Design

## Goal

Keep ShareGuard's private media custody inside Cloudflare R2's Standard-storage
free tier while preserving the P0 evidence workflow. The limit must apply to the
entire deployment, not to an individual IP address or browser.

## Limits

- Store at most 100 newly reserved media objects per UTC day across the site.
- Count at most 8,000,000,000 plaintext media bytes that have not been
  explicitly confirmed deleted.
- Keep each reservation in the quota ledger until confirmed deletion.
- Continue enforcing the existing 8 MiB per-object upload limit.
- Fail closed when the quota binding or its configuration is unavailable.

The daily object limit independently bounds the normal seven-day footprint to
less than 5.9 GiB even when every object reaches the 8 MiB upload ceiling. The
8 GB byte ceiling is a second guard for future upload-size changes.

## Architecture

Add a singleton `ShareGuardStorageQuota` SQLite Durable Object. Every Worker
instance resolves the same object with `idFromName("global-media")`, so requests
from different IP addresses and concurrent isolates share one transactionally
updated quota ledger.

Before a private R2 write, the Worker sends the opaque version ID and plaintext
byte size to the quota object. A successful reservation counts immediately and
remains counted until the Worker proves that the corresponding R2 object was
deleted and releases the reservation.

The lifecycle deadline does not automatically reduce the quota ledger. R2 may
apply lifecycle deletion asynchronously, so an unconfirmed object remains
counted even after its retention metadata expires. This can conservatively
reduce available capacity, but it prevents delayed lifecycle processing from
creating unmetered billable storage. A later reconciliation tool may release
entries only after R2 confirms that their objects no longer exist.

Reservations are idempotent by version ID. A repeated reservation must carry
the same byte size. Known failures before or during R2 storage release the
reservation only after cleanup confirms that no object remains. Ambiguous
cleanup keeps the reservation counted, preferring temporary capacity loss over
untracked billable storage.

## Responses And Readiness

Quota exhaustion returns HTTP `507` with `storage_quota_exceeded` and a bounded
`Retry-After`. Quota infrastructure failure returns HTTP `503` with
`storage_quota_unavailable`. `/v1/ready` treats the quota binding and positive
limit configuration as production requirements when private media custody is
required.

## R2 Configuration

Use Standard storage only. Configure the private bucket with a seven-day object
expiration lifecycle. The bucket remains non-public. Billing notifications are
useful warnings but are not treated as enforcement.

## Verification

- Unit-test reservation idempotency, cumulative daily rejection, byte
  rejection, conservative expiry handling, release, malformed requests, and
  concurrent transactional behavior.
- Integration-test fail-closed quota handling before R2 writes.
- Integration-test quota release after confirmed cleanup and retention after
  ambiguous cleanup.
- Run the complete Worker and Python suites, Wrangler dry-run, and production
  health/readiness and upload checks before updating the website branch.
