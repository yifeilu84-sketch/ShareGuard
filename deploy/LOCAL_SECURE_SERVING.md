# Local protected serving

ShareGuard uses two loopback-only processes:

- `127.0.0.1:7860`: public web gateway
- `127.0.0.1:7861`: token-protected private inference

The browser never receives the internal API token or model files. Model
artifacts, cache files, logs, PID state, and local secrets are ignored by Git.
On Windows, public backbone files default to the short
`%LOCALAPPDATA%\ShareGuard\cache` path to avoid legacy `MAX_PATH` failures. Set
`SHAREGUARD_LOCAL_CACHE` only when a different private cache location is needed.

## Bootstrap

```powershell
.\scripts\local\bootstrap_serving.ps1
```

## Start for local testing

```powershell
.\scripts\local\start_protected_platform.ps1
```

After the public backbones have been cached successfully, use offline mode:

```powershell
.\scripts\local\start_protected_platform.ps1 -Offline
```

Offline startup verifies the revision, byte size, and SHA-256 of all three
public backbone files against `deploy/backbone-lock.json` before loading them.

For a Cloudflare Access protected tunnel:

```powershell
.\scripts\local\start_protected_platform.ps1 -AccessProtected -Offline
```

## Temporary private demo without a domain

Cloudflare Access requires an active domain in the Cloudflare account. Until a
domain is available, start a password-protected gateway and publish it through a
development-only Quick Tunnel:

```powershell
.\scripts\local\stop_protected_platform.ps1
.\scripts\local\start_protected_platform.ps1 -PasswordProtected -Offline
.\scripts\local\publish_quick_tunnel.ps1
```

The script generates a 32-character random password, keeps it under the ignored
`secrets` directory, and writes the temporary URL plus public-demo credentials
to `secrets/quick-tunnel-access.txt`. No credential is embedded in JavaScript or
committed to Git.

Quick Tunnel URLs are temporary and have no uptime guarantee. Use this mode only
for controlled judging, review, and development sessions. Stop the stack as soon
as the session ends.

## Status and stop

```powershell
.\scripts\local\status_protected_platform.ps1
.\scripts\local\stop_protected_platform.ps1
```

Never publish port `7861`, the `secrets` directory, the configured local cache,
or `model_artifacts`.
