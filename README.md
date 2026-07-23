# appanypercent

Turn an app idea into a live `https://<name>.exe.xyz` app backed by its own isolated
PlanetScale Postgres branch — provisioned, generated (by an embedded [Pi](https://github.com/earendil-works/pi) agent
running inside the VM), migrated, and verified, in one command.

```
idea ──▶ exe.dev micro-VM ──▶ PlanetScale branch + 2 scoped roles ──▶ secrets ──▶ Pi generates app
     ──▶ prisma migrate (direct :5432) ──▶ MCP schema verify ──▶ proxy pinned to PORT ──▶ live ✅
```

## Install (2 commands)

```bash
curl -fsSL https://raw.githubusercontent.com/vaughanlove/appanypercent/main/install.sh | bash
appanypercent setup
```

The one-liner clones the harness to `~/.appanypercent`, installs pinned deps (including Pi), and
links `appanypercent` into `~/.local/bin`. `setup` is the interactive first-run: installs `pscale`
if missing, registers your SSH key with exe.dev, prompts config/secrets into `./.env` (0600,
auto-loaded by the CLI; real env vars win), and finishes with `doctor`. Both are idempotent —
re-run after fixing anything. (Working from a clone instead? `./fresh-install.sh` ≡ `setup`,
and `npm run <cmd> --` ≡ `appanypercent <cmd>`.)

## Use

**Interactive (the main interface):** just run it with no arguments —

```bash
appanypercent
```

…which opens a Pi session inside the harness with the pipeline registered as tools
(`provision_app`, `teardown_app`, `verify_app`, `app_status`, `plan_app`, `doctor`) plus the normal
read/bash/edit/write tools and a `harness-ops` playbook skill. So you can drive it conversationally:

> “provision a guestbook called demo, make it public” · “is demo healthy? check its logs” ·
> “add a dueDate column to demo's schema and re-migrate” · “tear down everything matching pipe-*”

Long steps stream live into the session; provisioning stays idempotent and state-backed, so the
agent can retry failed steps safely. First launch asks you to trust the project (that loads `.pi/`).

**Scripting (same engine, one-shot):**

```bash
appanypercent plan --app demo --idea "a guestbook"        # dry run — prints every command, runs nothing
appanypercent provision --app demo --idea "a guestbook" --public   # the real thing (~minutes)
open https://demo.exe.xyz                                 # it's live
appanypercent teardown --app demo                         # destroy VM + branch + roles, ~free
appanypercent update                                      # pull harness updates + Pi pin bumps
```

Run `npx tsx src/cli.ts` with no arguments any time to see the walkthrough again.

## What you'll see

`./fresh-install.sh` walks tooling → exe.dev key registration → config prompts → PlanetScale auth,
then hands off to `npm run doctor` (the source of truth — every ✗ comes with a copy-pasteable remedy):

```
appanypercent doctor — checking everything provisioning needs

 ✓ node                 v22.11.0
 ✓ ssh                  installed
 ✓ rsync                installed
 ✓ exe.dev              authenticated as you@example.com
 ✓ planetscale          auth OK, database myorg/apps exists
 ✓ branch main          parent branch exists on apps
 ! mcp                  PLANETSCALE_API_TOKEN not set
                        → export PLANETSCALE_API_TOKEN=<service token> ... Optional; step degrades to a NOTICE.
 ✓ llm key              ANTHROPIC_API_KEY set (forwarded to the VM for the Pi generation step)

ready with 1 warning(s) — you can provision; warned features degrade gracefully.

next:  npm run plan      -- --app demo --idea "a guestbook"   (dry run, prints every command)
       npm run provision -- --app demo --idea "a guestbook" --public
```

`npm run provision` then walks 9 named steps (`vm.create → db.branch → db.roles → vm.secrets →
app.generate → db.migrate → db.promote → app.start → verify.live`), each logged as
`[step ...]`, persisted to `state/<app>.json`, and resumable: re-running skips completed steps.
Failures are loud and step-attributed with a remedy line — never a silent hang.

## How to test this

A ladder, cheapest first:

1. **Free, offline:** `npm test` — runs `doctor` + a dry-run `plan`. The installer itself can be
   tested without touching your system: stub `pscale` on PATH and pipe `</dev/null` (non-interactive
   mode skips prompts and registration). Also:
   `npm run plan -- --app demo --idea "x"` works even before any credentials are set
   (placeholders shown), so you can inspect exactly what would execute.
2. **Free, read-only against real services:** `npm run doctor` — authenticates to exe.dev and
   PlanetScale, checks the parent DB and `main` branch, pings the MCP server. Touches nothing.
3. **Cheap end-to-end (~$5/mo pro-rated by the minutes it exists):**
   ```bash
   npm run provision -- --app pipe-test --idea "one page that lists rows from a table called notes and a form to add one" --public
   curl -i https://pipe-test.exe.xyz/healthz          # expect 200 ok
   npm run status -- --app pipe-test                  # all 9 steps done: true
   npm run provision -- --app pipe-test --idea "..."  # idempotency check: all steps skip
   npm run teardown -- --app pipe-test                # everything gone
   ```
4. **Failure-path drills** (verify loudness, on a provisioned test app):
   - Port contract: `ssh exe.dev share port pipe-test 9999` then `npm run verify -- --app pipe-test`
     → fails at level 2 with the exact re-pin command.
   - App down: `ssh pipe-test.exe.xyz "pkill -f 'npm start'"` then `verify` → fails at level 1
     with the log/`ss` inspection command.
   - Resume: delete `state/pipe-test.json`'s `app.start` entry and re-run `provision` → only that
     step re-executes.
   - Half-provisioned teardown: `teardown` right after killing a provision mid-`db.roles` → all
     deletes tolerate "already gone".

## Repo map

| path | what |
|---|---|
| `src/cli.ts` | commands: doctor, plan, provision, verify, status, teardown |
| `src/provision.ts` | the 9-step orchestrator (idempotent, state-backed) |
| `src/deploy-request.ts` | the deploy-request step — **read its header**: PlanetScale Postgres has no deploy requests today; documented adaptation + MCP verification |
| `.pi/` | **operator-side** harness: provisioner tools extension + harness-ops skill (loaded by `appanypercent` interactive) |
| `vm/.pi/` | **VM-side** Pi customization shipped to app VMs: port-contract extension, exe-app/planetscale-prisma/exe-auth skills |
| `agent/` | VM-side embedded-Pi runner, Pi pinned at 0.81.1 |
| `PLAN.md` | design, secrets/blast-radius model, doc ambiguities found |
| `RUNBOOK.md` | full ops runbook incl. common failures |
