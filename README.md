# appanypercent

Turn an app idea into a live `https://<name>.exe.xyz` app backed by its own isolated
PlanetScale Postgres branch — provisioned, generated (by an embedded [Pi](https://github.com/earendil-works/pi) agent
running inside the VM), migrated, and verified, in one command.

```
idea ──▶ exe.dev micro-VM ──▶ PlanetScale branch + 2 scoped roles ──▶ secrets ──▶ Pi generates app
     ──▶ prisma migrate (direct :5432) ──▶ MCP schema verify ──▶ proxy pinned to PORT ──▶ live ✅
```

## Quickstart

```bash
git clone <this repo> && cd appanypercent
./fresh-install.sh                               # 0. one-command setup: deps, pscale, exe.dev key,
                                                 #    prompts for config -> ./.env, then runs doctor
npm run plan -- --app demo --idea "a guestbook"  # 1. dry run — prints every command, runs nothing
npm run provision -- --app demo --idea "a guestbook" --public   # 2. the real thing (~minutes)
open https://demo.exe.xyz                        # 3. it's live
npm run teardown -- --app demo                   # 4. destroy VM + branch + roles, ~free
```

`fresh-install.sh` is idempotent — re-run it after fixing anything; it keeps existing answers
(stored in `./.env`, gitignored, chmod 600, auto-loaded by the CLI; real env vars always win).
Prefer manual setup? Export the env vars listed in `npx tsx src/cli.ts` help and run `npm run doctor`.

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
| `.pi/` | Pi customization (no fork): port-contract extension, exe.dev + PlanetScale/Prisma skills |
| `agent/` | VM-side embedded-Pi runner, Pi pinned at 0.81.1 |
| `PLAN.md` | design, secrets/blast-radius model, doc ambiguities found |
| `RUNBOOK.md` | full ops runbook incl. common failures |
