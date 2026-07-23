# PLAN — per-app provisioning pipeline (exe.dev + PlanetScale Postgres + Prisma + Pi)

Date of doc research: all facts below were pulled from live docs on the day this was written:
exe.dev (`https://exe.dev/docs/*.md`), PlanetScale (`https://planetscale.com/docs/**.md` + `/docs/llms.txt`),
Prisma CLI reference (`prisma.io/docs/orm/reference/prisma-cli-reference.md`), and the locally installed
Pi docs (`@earendil-works/pi-coding-agent` v0.81.1).

## 0. Doc ambiguities / conflicts found (read this first)

1. **PlanetScale Postgres does NOT have deploy requests.** The Postgres branching doc says verbatim:
   *"Since PlanetScale Postgres branches don't use deploy requests like in Vitess, you make schema
   changes directly on each branch"* and *"There's currently no automated way to merge schema changes
   between PlanetScale Postgres branches."* The `pscale deploy-request` CLI doc says it "is not
   currently available for Postgres database clusters."
   → **Adaptation (not a redesign):** each app's branch is a fully isolated database (per docs:
   "Branches are completely isolated databases", own storage, own credentials), so the per-app branch
   **is** the app's durable production database. There is nothing to merge: `main` stays empty and is
   only the parent for branch creation. The "open + merge deploy request" step is implemented in
   `src/deploy-request.ts` as (a) a **schema verification** via the hosted MCP server's real
   `planetscale_get_branch_schema` tool, and (b) a `PLACEHOLDER` code path, loudly logged, for the
   Vitess-style DR flow if PlanetScale ships it for Postgres.

2. **The hosted PlanetScale MCP server has no branch/role/deploy-request mutation tools.** Its
   documented tool list (16 tools) covers list/get orgs/databases/branches, get schema, read/write
   *SQL queries*, insights, docs search, invoices. There are no `create_branch` / `create_deploy_request`
   / `merge` tools. The local `pscale mcp server` is deprecated ("prefer hosted MCP").
   → Branch and role provisioning uses the official `pscale` CLI (`pscale branch create/delete`,
   `pscale role create/delete` — both documented for Postgres, service-token automatable). This is the
   official CLI, not hand-rolled REST. The MCP server is used for what it actually offers today:
   post-migration schema verification (`planetscale_get_branch_schema`) with service-token auth
   (`PLANETSCALE_API_TOKEN`, documented for headless use).

3. **`pscale role create` JSON output fields are not documented** (docs show human output only).
   The code extracts `username`/`password`/hostname defensively and fails loudly, printing the actual
   keys it received, if the shape differs. Marked `PLACEHOLDER-VERIFY` in `src/planetscale.ts`.

4. **Prisma v7 removed `--from-url/--to-url/--url/--shadow-database-url`** from `migrate diff` /
   `db execute`; connection now comes from `prisma.config.ts` (`datasource.url = env(...)`). We pin
   Prisma 7 and follow the documented pattern exactly:
   `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` piped into
   `db execute`. `migrate deploy` (migration-history flavor) is intentionally not used: on a fresh
   isolated branch, diff→execute is idempotent (`--exit-code`: 0 = in sync, 2 = changes) and needs no
   shadow database. schema.prisma remains the source of truth.

5. **How exe.dev `--env` vars are exposed inside the VM is not precisely documented.** We therefore do
   not rely on it for secrets; secrets are written over SSH to `~/app/.env` (mode 0600). See §3.

## 1. Why a small TypeScript CLI (not a bash script)

- Pi is embedded via its TypeScript SDK, so Node/TS is already required.
- Both control planes are JSON-first (`ssh exe.dev ... --json`, `pscale ... --format json`); typed
  parsing + a persisted step state machine beats bash string-munging for idempotency/diagnostics.
- Runs with `tsx`, no build step. Entry: `npm run provision` / `npm run teardown` / `npm run verify`.

## 2. Per-app sequence (each step persisted to `state/<app>.json`)

| # | step id      | action | tooling (verified syntax) |
|---|--------------|--------|---------------------------|
| 1 | `vm.create`  | Create micro-VM | `ssh exe.dev new --name <app> --json` |
| 2 | `db.branch`  | Create isolated per-app branch off `main` | `pscale branch create <db> <app> --wait --format json` |
| 3 | `db.roles`   | Two least-privilege roles, scoped to this branch only | `pscale role create <db> <app> <app>-migrate --inherited-roles postgres` and `... <app>-runtime --inherited-roles pg_read_all_data,pg_write_all_data` |
| 4 | `vm.secrets` | Write `~/app/.env` (0600) over SSH | `ssh <app>.exe.xyz 'umask 077 && ... cat > ~/app/.env'` |
| 5 | `app.generate` | Run Pi **inside the VM** (embedded SDK + our `.pi/` extensions & skills) to generate app + `schema.prisma` | rsync `agent/` + `.pi/` to VM; `node runner.mjs "<idea>"` |
| 6 | `db.migrate` | Apply schema over **direct** connection from the VM | `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code -o` → `prisma db execute --file` (datasource = `DIRECT_DATABASE_URL`) |
| 7 | `db.promote` | "Deploy request open+merge" — see §0.1. Verifies applied schema via hosted MCP `planetscale_get_branch_schema`; Vitess-style DR path is a loud placeholder | MCP Streamable HTTP, `PLANETSCALE_API_TOKEN` bearer |
| 8 | `app.start`  | Start app on the contracted port, point proxy at it **explicitly** | `ssh <vm> 'nohup npm start'` + `ssh exe.dev share port <app> <port>` |
| 9 | `verify.live`| Two-level check: in-VM `curl localhost:<port>/healthz`, then external `https://<app>.exe.xyz` | distinguishes app-down vs proxy-misroute |

Every step: fails loudly (non-zero exit, step name, remedy hint), records `done` in state, and is
skipped on re-run if `done` (idempotent). A crash leaves a state file that tells you exactly which
step half-completed.

## 3. Secrets & credential model (what lands where, blast radius)

| Secret | Lives where | Used by | Blast radius if leaked |
|---|---|---|---|
| `DIRECT_DATABASE_URL` (`<app>-migrate` role, port **5432**, `sslmode=verify-full`) | VM `~/app/.env` only | Prisma CLI on the VM | **One branch** = one app's DB. Role inherits `postgres` (branch-scoped near-superuser) because docs state `pg_write_all_data` does **not** grant DDL; branches are isolated so this never touches other apps or `main`. |
| `DATABASE_URL` (`<app>-runtime` role, PgBouncer port **6432**) | VM `~/app/.env`; the only URL the app process reads | app runtime | One branch, data-plane only (`pg_read_all_data,pg_write_all_data`, no DDL). Rotate via `pscale role reset` without touching the migrate role. |
| LLM API key for Pi (e.g. `ANTHROPIC_API_KEY`) | VM `~/app/.env` (exported only for the generation step) | Pi runner in VM | your LLM account. Alternative: exe.dev's LLM integration/gateway keeps the key off-VM entirely — noted as an option, not implemented. |
| `PLANETSCALE_SERVICE_TOKEN(_ID)` | **operator machine only** (env), never on any VM | `pscale` CLI + MCP verification | whole PS org scope of the token. Deliberately never leaves the control machine. |
| exe.dev auth | operator's SSH key (SSH is the exe.dev API) | `ssh exe.dev ...` | your exe.dev account; never on VMs. |

App code is credential-free: it reads `process.env.DATABASE_URL`/`PORT` from `~/app/.env`. Roles and
connection strings are re-derivable from PlanetScale; the VM disk holds nothing the harness cannot
recreate (VMs are disposable; durable state = PlanetScale + this repo's `state/` records).

Username format (verified): `{role}.{branch_id}`; password prefix `pscale_pw_`; host
`{id+region}.horizon.psdb.cloud`; TLS required (`sslmode=verify-full`).

## 4. Pi integration (embedded, extension-over-modification)

- Pi is consumed as a pinned npm dependency (`@earendil-works/pi-coding-agent@0.81.1`, exact pin in
  both `package.json`s + lockfile). **No fork.** No core-behavior change was needed; the extension API
  (tool_call interception, skills) covered everything. If a future need touches the agent loop,
  compaction internals, or the four-tool contract → STOP and flag before forking.
- Generation runs **inside the app's VM** (Pi has no permission system; the KVM-isolated VM is the
  security boundary — the control machine never runs Pi against untrusted output).
- The VM runner (`agent/runner.mjs`) uses `createAgentSession()` + `DefaultResourceLoader` with
  `cwd=~/app`, so our project `.pi/` loads: 
  - `.pi/settings.json` — loads extensions/skills.
  - `.pi/extensions/port-contract.ts` — intercepts `write`/`edit` tool calls and **blocks** any
    server code that hardcodes a listen port instead of `process.env.PORT` (the #1 first-run failure).
  - `.pi/skills/exe-app/SKILL.md` — exe.dev proxy/port contract, healthz requirement, X-Forwarded-* headers.
  - `.pi/skills/planetscale-prisma/SKILL.md` — schema.prisma/prisma.config.ts conventions, pooled vs
    direct URL rules (runtime = 6432, never DDL at runtime).

## 5. App ↔ proxy port contract (explicit, can't fail silently)

Single source of truth: `APP_PORT` (default **8080**, `--port` to override). It is (a) written to
`~/app/.env` as `PORT`, (b) enforced at generation time by the port-contract extension, (c) set
explicitly on the proxy via `ssh exe.dev share port <app> <port>` — we never rely on exe.dev's
auto-pick ("smallest exposed TCP port") — and (d) verified twice: in-VM `curl localhost:$PORT/healthz`
(app up?) then external `https://<app>.exe.xyz/` (proxy routed?). A mismatch produces a step-named,
actionable error, never a silent hang. (Docs note: ports 3000–9999 are also transparently forwarded
at `https://<app>.exe.xyz:<port>/` for authenticated users — useful for debugging.)

## 6. Teardown (cheap, ordered, re-runnable)

`npm run teardown -- --app <name>`:
1. `ssh exe.dev rm <app>` (VM + disk gone; nothing durable lived there)
2. `pscale role delete <db> <app> <role-id> --force --successor postgres` (both roles; successor
   required because the migrate role owns the tables — documented behavior)
3. `pscale branch delete <db> <app> --force`
4. remove `state/<app>.json`

Each teardown step tolerates "already gone" and re-runs cleanly, so a half-provisioned app is
destroyed by the same command.
