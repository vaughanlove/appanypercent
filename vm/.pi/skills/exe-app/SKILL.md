---
name: exe-app
description: Rules for building web apps that run on exe.dev micro-VMs behind the exe.dev HTTPS proxy. Use whenever creating or modifying the HTTP server, ports, or deployment-facing config.
---

# Building an app for an exe.dev VM

This app runs on an exe.dev micro-VM behind this chain (each hop provisioned by the harness):

```
exe.dev :443 (TLS) ─▶ VM :8000 (nginx edge: gates /admin + /api/admin) ─▶ 127.0.0.1:$PORT (this app)
```

Facts from https://exe.dev/docs/proxy:

- The exe.dev proxy forwards to ONE configured port — the harness pins it to the nginx edge (:8000);
  nginx proxies to the app on `process.env.PORT`.
- Requests arrive as plain HTTP with `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`
  headers. Trust these for absolute URLs; do not force HTTPS redirects yourself.
- Ports 3000–9999 are also reachable at `https://<vmname>.exe.xyz:<port>/` for authenticated users
  (debugging only — do not design around this).

## Hard rules

1. `const port = Number(process.env.PORT); server.listen(port, "127.0.0.1")`. Never a literal
   port. Loopback is correct — nginx is the only intended caller; do not bind 0.0.0.0.
2. Provide `GET /healthz` → `200 "ok"` with no auth and no DB dependency (used by the harness).
3. `package.json` must have `"start"` running the production server (no watch/dev mode).
4. No TLS in-app; the proxy owns certificates.
5. If using Next.js/Vite dev tooling, remember the public hostname is `<vmname>.exe.xyz`
   (`allowedDevOrigins` / `server.allowedHosts`) — but production `npm start` should not be a dev server.
6. User accounts/login: see the `exe-auth` skill — exe.dev provides authentication at the proxy
   ("Login with exe" headers); never roll your own.
