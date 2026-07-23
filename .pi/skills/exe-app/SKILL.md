---
name: exe-app
description: Rules for building web apps that run on exe.dev micro-VMs behind the exe.dev HTTPS proxy. Use whenever creating or modifying the HTTP server, ports, or deployment-facing config.
---

# Building an app for an exe.dev VM

This app runs on an exe.dev micro-VM. `https://<vmname>.exe.xyz/` terminates TLS at exe.dev's
proxy on :443 and forwards to ONE port inside this VM. The provisioning harness pins that port to
`process.env.PORT`. Facts from https://exe.dev/docs/proxy:

- The proxy forwards to a single configured port (`ssh exe.dev share port` — the harness does this).
- Requests arrive as plain HTTP with `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`
  headers. Trust these for absolute URLs; do not force HTTPS redirects yourself.
- Ports 3000–9999 are also reachable at `https://<vmname>.exe.xyz:<port>/` for authenticated users
  (debugging only — do not design around this).

## Hard rules

1. `const port = Number(process.env.PORT); server.listen(port, "0.0.0.0")`. Never a literal port.
2. Provide `GET /healthz` → `200 "ok"` with no auth and no DB dependency (used by the harness).
3. `package.json` must have `"start"` running the production server (no watch/dev mode).
4. No TLS in-app; the proxy owns certificates.
5. If using Next.js/Vite dev tooling, remember the public hostname is `<vmname>.exe.xyz`
   (`allowedDevOrigins` / `server.allowedHosts`) — but production `npm start` should not be a dev server.
