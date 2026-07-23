---
name: exe-auth
description: Authentication for apps behind the exe.dev proxy — two-plane model (public vs operator), Login-with-exe identity headers, ADMIN_USER/ADMIN_PASSWORD gating for admin and data routes. Use whenever the app has user accounts, admin pages, data listing/export APIs, or destructive actions.
---

# Authentication: two planes, fails closed

Every app has two planes. Design routes into one of them EXPLICITLY, before writing handlers:

| Plane | Examples | Protection |
|---|---|---|
| **Public** | landing page, submit-a-thing forms, per-user pages | none, or per-user identity (below) |
| **Operator/admin** | dashboards, order/user lists, ANY route that reads bulk data, exports, deletes | **required, by construction** |

The #1 observed failure: an unauthenticated `GET /api/orders` returning all customer PII on a
public app. Never emit a route that reads other users' data without protection.

## Operator plane (MANDATORY rules)

- Mount ALL admin/operator routes under `/admin` (pages) and `/api/admin` (APIs). The platform
  enforces HTTP Basic auth on exactly these prefixes at an nginx edge in front of the app — using
  a conventional prefix is what makes the edge gate cover you.
- ADDITIONALLY gate them in-app (defense in depth): check HTTP Basic credentials against
  `process.env.ADMIN_USER` / `process.env.ADMIN_PASSWORD` (always present in `.env`), constant-time
  compare, else `401` with `WWW-Authenticate: Basic realm="operator"`.
- Bulk reads/exports/deletes that don't feel like "admin pages" are STILL operator plane — put them
  under `/api/admin/...`.
- `GET /healthz` stays unauthenticated and outside `/admin`.

## Public plane per-user identity: "Login with exe"

exe.dev's proxy injects trusted headers on authenticated requests (https://exe.dev/docs/login-with-exe):

- `X-ExeDev-UserID` — stable unique ID (use as the foreign key) · `X-ExeDev-Email`
- Login: redirect to `/__exe.dev/login?redirect={path}` · Logout: `POST /__exe.dev/logout`

Pattern: middleware reads headers into `req.user`; lazy Prisma upsert:

```prisma
model User {
  id        String   @id            // X-ExeDev-UserID
  email     String
  createdAt DateTime @default(now())
}
```

On a PRIVATE app every request has these headers. On a PUBLIC app anonymous requests won't —
redirect to the login URL (HTML) or 401 (API) when identity is required.

## Rules

- No password storage, no self-managed sessions/JWTs, no third-party OAuth. The proxy owns user
  authn; ADMIN_USER/ADMIN_PASSWORD owns the operator plane.
- Only trust the X-ExeDev-* headers via the exe.dev proxy. Local testing: inject with
  `mitmdump --mode reverse:http://localhost:8000 --listen-port 3000 --set modify_headers='/~q/X-Exedev-Email/user@example.com' --set modify_headers='/~q/X-Exedev-Userid/usr1234'`
- App-managed accounts (e.g. better-auth) only if the operator EXPLICITLY requests them.
