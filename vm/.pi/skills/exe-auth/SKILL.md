---
name: exe-auth
description: Authentication for apps behind the exe.dev proxy — use "Login with exe" identity headers, never passwords or third-party OAuth. Use whenever the app needs user accounts, login, sessions, or per-user data.
---

# Authentication: use "Login with exe" (exe.dev's recommended pattern)

This app runs behind the exe.dev HTTPS proxy, which provides authentication as a platform
feature (https://exe.dev/docs/login-with-exe). Do NOT build password auth, do NOT integrate
third-party OAuth providers, do NOT add heavyweight auth frameworks by default.

## How it works

When a user is authenticated with exe.dev, the proxy injects trusted headers into every request:

- `X-ExeDev-UserID` — stable, unique user identifier (use this as your foreign key)
- `X-ExeDev-Email` — the user's email address

These headers are only present when the user is authenticated. On a **private** proxy (default)
every request has them. On a **public** proxy, anonymous requests won't have them — send users
who need to log in to:

- Login: redirect to `/__exe.dev/login?redirect={path-to-return-to}`
- Logout: `POST /__exe.dev/logout` (e.g. a form button)

## Implementation pattern

1. Middleware reads the headers into `req.user = { id, email }` (or equivalent).
2. Persist users lazily in Prisma, keyed on the stable ID:

   ```prisma
   model User {
     id        String   @id            // X-ExeDev-UserID
     email     String
     createdAt DateTime @default(now())
   }
   ```

   Upsert on first authenticated request; reference `User.id` from user-owned rows.
3. Routes needing identity: if the headers are absent, redirect (HTML) to
   `/__exe.dev/login?redirect=<original path>` or return 401 (API).
4. `GET /healthz` must stay unauthenticated.

## Rules

- No password storage, no session cookies of your own, no JWT issuing — the proxy owns authn.
  Your job is only authorization (which user may do what) using the header identity.
- Only trust these headers on requests arriving via the exe.dev proxy (which controls them).
  For local testing without the proxy, inject them with a dev reverse proxy, e.g.:
  `mitmdump --mode reverse:http://localhost:8000 --listen-port 3000 --set modify_headers='/~q/X-Exedev-Email/user@example.com' --set modify_headers='/~q/X-Exedev-Userid/usr1234'`
- Only if the operator EXPLICITLY asks for app-managed accounts independent of exe.dev
  (e.g. public signup with its own user base) may you add an auth framework such as better-auth —
  and even then, check its current docs rather than assuming API shapes.
