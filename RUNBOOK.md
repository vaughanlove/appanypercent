# RUNBOOK — provision & tear down one app end-to-end

## One-time operator setup (control machine, never on VMs)

1. **exe.dev** — the API is SSH. Verify: `ssh exe.dev ls --json` (register your SSH key at exe.dev
   first if this prompts).
2. **PlanetScale** — install `pscale`, then either `pscale auth login` (interactive) or headless:
   ```bash
   export PLANETSCALE_SERVICE_TOKEN_ID=...   # service token with branch/role/DR access
   export PLANETSCALE_SERVICE_TOKEN=...
   export PLANETSCALE_API_TOKEN="$PLANETSCALE_SERVICE_TOKEN"  # documented headless auth for the hosted MCP server
   ```
3. **The shared parent database** (once, not per app): create a PlanetScale **Postgres** database,
   e.g. `apps`, and leave `main` empty — it only serves as the parent for per-app branches.
   ```bash
   export PS_ORG=<your-org>
   export PS_DATABASE=apps
   ```
4. **LLM key for Pi** (used only inside each app VM during generation):
   ```bash
   export ANTHROPIC_API_KEY=...   # or another key + `--llm-env NAME`
   ```
5. `npm install` in this repo (Pi is pinned at 0.81.1 via package-lock.json).

## Provision one app

```bash
npm run provision -- --app todo-cats --idea "A todo list for cat-care chores with due dates" --public
```

Flags: `--port 8080` (the app↔proxy contract, default 8080) · `--public` (skip exe.dev login wall) ·
`--region <r>` (PlanetScale branch region) · `--org/--database` (override env).

What you'll see, in order (each step is persisted to `state/todo-cats.json`):

| step | what happens | how to eyeball it |
|---|---|---|
| `vm.create` | `ssh exe.dev new --name todo-cats` | `ssh exe.dev ls` |
| `db.branch` | `pscale branch create apps todo-cats --wait` — this branch **is** the app's isolated DB | `pscale branch list apps` |
| `db.roles` | `todo-cats-migrate` (DDL, inherits `postgres`) + `todo-cats-runtime` (DML-only) | `pscale role list apps todo-cats` |
| `vm.secrets` | `~/app/.env` on the VM (0600): `PORT`, `DATABASE_URL` (:6432 pooled), `DIRECT_DATABASE_URL` (:5432), LLM key | `ssh todo-cats.exe.xyz cat ~/app/.env` |
| `app.generate` | embedded Pi runs **in the VM** with `.pi/` skills + the port-contract extension; streams output | log: `~/app/.agentrunner/session.log` |
| `db.migrate` | `prisma migrate diff --from-config-datasource --to-schema ... --script` → `prisma db execute` over the **direct** URL | exit-code 0 next run = in sync |
| `db.promote` | MCP `planetscale_get_branch_schema` verification (Postgres has no deploy requests — PLAN.md §0.1; a NOTICE is printed) | |
| `app.start` | `npm start` under nohup; **explicit** `ssh exe.dev share port todo-cats 8080`; `share set-public` if `--public` | `ssh exe.dev share show todo-cats` |
| `verify.live` | level 1: in-VM `curl localhost:8080/healthz`; level 2: `https://todo-cats.exe.xyz/` | open the URL |

Success line: `✅ todo-cats is live: https://todo-cats.exe.xyz`.

### Re-running / resuming

`provision` is idempotent: completed steps are skipped. If it dies mid-flight, the failure names the
step and a remedy; fix and re-run the same command. To force a step to re-run, delete its entry from
`state/<app>.json`. `npm run status -- --app todo-cats` dumps the state record. New here? Run `npm run doctor` first and `npm run plan` for a dry run — see README.md.

### Common failures (all fail loudly)

- **`verify.live` level 1 fails** → the app isn't on the contracted port. `ssh todo-cats.exe.xyz 'tail -50 ~/app/app.log; ss -tlnp'`. The port-contract extension should have prevented hardcoded ports; if the app crashed, fix and `re-run provision` (app.start re-executes if you clear its state entry).
- **`verify.live` level 2 fails** → proxy target drifted. `ssh exe.dev share port todo-cats 8080`.
- **`db.roles` fails with "Could not extract role credentials"** → `pscale` JSON shape changed; the error prints the keys received; adjust `extractRoleCred()` in `src/planetscale.ts` (marked PLACEHOLDER-VERIFY).
- **`db.migrate` permission denied for schema public** → migration ran as the runtime role; check `DIRECT_DATABASE_URL` uses the `-migrate` role (docs: `pg_write_all_data` grants no DDL).

## Verify later / after redeploys

```bash
npm run verify -- --app todo-cats            # re-runs both liveness levels
npm run status -- --app todo-cats            # provisioning record
```

## Tear down one app

```bash
npm run teardown -- --app todo-cats
```

Order (each tolerates "already gone" — safe on half-provisioned apps):
1. `ssh exe.dev rm todo-cats` — VM + disk gone. Nothing durable lived there by design.
2. `pscale role delete apps todo-cats <role-id> --force --successor postgres` (runtime, then migrate; successor required because the migrate role owns the tables).
3. `pscale branch delete apps todo-cats --force` — drops the app's entire database.
4. Removes `state/todo-cats.json`.

Cost note: dev branches are billed only while they exist (~$5/mo baseline per PS docs) and exe.dev
VMs share plan CPU/RAM — spin up/destroy freely.

## What NOT to do

- Don't hand out `main`'s default `postgres` role to anything — per-app roles only.
- Don't run migrations over the :6432 pooled URL (PgBouncer transaction mode + no DDL privileges).
- Don't fork Pi. If the extension API can't do something you need (agent loop, compaction internals,
  four-tool contract), stop and flag it — see PLAN.md §4.
