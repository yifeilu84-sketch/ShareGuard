# Cloudflare Access publication

The public GitHub Pages site remains static. The real-model site is published
through a named Cloudflare Tunnel and must be protected by a Cloudflare Access
self-hosted application before DNS is routed.

Cloudflare Access publication requires an active domain in the account. If the
account has no domain yet, use the temporary password-protected workflow in
`deploy/LOCAL_SECURE_SERVING.md`; do not route an unprotected origin.

## 1. Authorize this machine

```powershell
.\scripts\local\cloudflare_login.ps1
```

## 2. Create the private tunnel configuration

```powershell
.\scripts\local\create_cloudflare_tunnel.ps1 `
  -Hostname demo.example.com
```

This step does not publish DNS.

## 3. Create the Access application

In Cloudflare Zero Trust, create a self-hosted application for the exact
hostname. Use an allow policy containing only approved judge and owner email
addresses. Enable MFA and use a short session duration.

## 4. Start the Access-protected local stack

```powershell
.\scripts\local\stop_protected_platform.ps1
.\scripts\local\start_protected_platform.ps1 -AccessProtected -Offline
```

## 5. Publish only after the policy exists

```powershell
.\scripts\local\publish_cloudflare_tunnel.ps1 `
  -AccessPolicyConfirmed
```

The origin accepts upload requests only when Cloudflare supplies an authenticated
identity header. Both local services remain bound to `127.0.0.1`.
