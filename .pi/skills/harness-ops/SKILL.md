---
name: harness-ops
description: Operating playbook for the appanypercent provisioning harness — how to provision, debug, and tear down apps on exe.dev + PlanetScale using the registered tools. Use for any request about creating, inspecting, fixing, or destroying apps.
---

# Operating the appanypercent harness

You are running inside the harness repo on the OPERATOR machine. You have these custom tools:
`provision_app`, `teardown_app`, `app_status`, `verify_app`, `plan_app`, `doctor` — plus normal
read/bash/edit/write for everything else. Architecture details: PLAN.md. Ops reference: RUNBOOK.md.

## Model

- One app = one exe.dev micro-VM (`<app>.exe.xyz`) + one isolated PlanetScale Postgres branch
  (the branch IS its database) + two scoped roles (migrate=DDL, runtime=DML via PgBouncer :6432).
- Provisioning is a 9-step idempotent state machine persisted in `state/<app>.json`.
  A failed run names the step; fix, then call `provision_app` again — done steps skip.
- VMs are disposable; durable state = PlanetScale + `state/`. Teardown is cheap and safe.

## Playbook

- **New app**: unclear requirements → ask; then `plan_app` (show the user), then `provision_app`.
  First-time environment doubts → `doctor` first.
- **"Is it up?"** → `verify_app`; deeper: `app_status`, then
  `bash: ssh <app>.exe.xyz 'tail -50 ~/app/app.log; ss -tlnp'`.
- **App code changes after generation**: ssh into the VM (`ssh <app>.exe.xyz`), edit under `~/app`,
  restart (`cd ~/app && set -a && . ./.env && set +a && pkill -f 'npm start'; nohup npm start > app.log 2>&1 &`).
  Schema change: edit `~/app/prisma/schema.prisma`, then clear the `db.migrate` and `db.promote`
  entries in `state/<app>.json` and re-run `provision_app` (re-applies diff idempotently).
- **Force one step to re-run**: delete its entry from `state/<app>.json` (edit tool), re-provision.
- **Destroy**: `teardown_app` — DESTRUCTIVE (drops the app's database). Unless the user explicitly
  asked to tear down, confirm first.
- **PlanetScale inspection**: `bash: pscale <cmd> --org $PS_ORG --format json` (branch list,
  role list, etc.). Credentials/URLs live in `state/<app>.json` and the VM's `~/app/.env` — never
  print passwords or connection strings into the conversation.

## Boundaries

- Never copy the operator-side `.pi/` or any pscale/exe.dev credentials onto a VM. Only `vm/.pi`
  ships to VMs (the provisioner does this itself).
- Don't hand-run `pscale branch delete` / `role delete` when `teardown_app` can do it — the tool
  keeps state consistent.
- Port contract: apps listen on `process.env.PORT` (default 8080) and the proxy is pinned
  explicitly. If routing breaks: `ssh exe.dev share show <app>`, re-pin with
  `ssh exe.dev share port <app> <port>`.
