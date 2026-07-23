/**
 * `npm run plan` — dry run. Prints the exact commands each provisioning step will execute for
 * this app, with current state (done/pending) if a state file exists. Executes NOTHING.
 * This is the cheapest way to sanity-check the pipeline and to learn what it does.
 */
import { EDGE_PORT, type Config } from "./config.ts";
import { loadState, stepDone } from "./state.ts";

export function plan(cfg: Config): void {
  const s = loadState(cfg.app);
  const host = `${cfg.app}.exe.xyz`;
  const db = cfg.psDatabase;
  const mark = (id: string) => (stepDone(s, id) ? "\x1b[32m[done]\x1b[0m   " : "\x1b[33m[pending]\x1b[0m");

  const steps: Array<[string, string, string[]]> = [
    ["vm.create", "create the exe.dev micro-VM", [
      `ssh exe.dev new --name ${cfg.app} --json`,
    ]],
    ["db.branch", "create the app's isolated PlanetScale Postgres branch (this IS its database)", [
      `pscale branch create ${db} ${cfg.app} --from main --wait --org ${cfg.psOrg} --format json${cfg.psRegion ? ` --region ${cfg.psRegion}` : ""}`,
    ]],
    ["db.roles", "create two least-privilege roles scoped to that branch", [
      `pscale role create ${db} ${cfg.app} ${cfg.app}-migrate --inherited-roles postgres --org ${cfg.psOrg} --format json`,
      `pscale role create ${db} ${cfg.app} ${cfg.app}-runtime --inherited-roles pg_read_all_data,pg_write_all_data --org ${cfg.psOrg} --format json`,
      `# builds DIRECT_DATABASE_URL (:5432, migrate role) and DATABASE_URL (:6432 PgBouncer, runtime role)`,
    ]],
    ["vm.secrets", "write secrets to the VM (only place credentials land off this machine)", [
      `ssh ${host} 'umask 077 && mkdir -p ~/app && cat > ~/app/.env'   # PORT=${cfg.port}, DATABASE_URL, DIRECT_DATABASE_URL, ADMIN_USER/ADMIN_PASSWORD (generated), ${cfg.llmEnvVars.join("/")}`,
    ]],
    ["app.generate", "run embedded Pi INSIDE the VM with .pi/ skills + port-contract extension", [
      `rsync agent/ ${host}:~/app/.agentrunner/   &&   rsync .pi/ ${host}:~/app/.pi/`,
      `ssh ${host} 'cd ~/app/.agentrunner && npm install'`,
      `ssh ${host} 'cd ~/app && . ./.env && IDEA_B64=<idea> node .agentrunner/runner.mjs'`,
    ]],
    ["db.migrate", "apply schema.prisma over the DIRECT (:5432) connection, from the VM (flags auto-match the installed Prisma major)", [
      `ssh ${host} 'npx prisma migrate diff --from-url "$DIRECT_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script --exit-code -o /tmp/migration.sql'`,
      `ssh ${host} 'npx prisma db execute --url "$DIRECT_DATABASE_URL" --file /tmp/migration.sql'   # only if exit-code was 2 (drift)`,
    ]],
    ["db.promote", "verify applied schema via hosted PlanetScale MCP (Postgres has no deploy requests — PLAN.md §0.1)", [
      `MCP tools/call planetscale_get_branch_schema {org:${cfg.psOrg}, database:${db}, branch:${cfg.app}}`,
    ]],
    ["app.start", "run the app under systemd (Restart=always, EnvironmentFile=~/app/.env, logs -> ~/app/app.log)", [
      `ssh ${host} 'sudo tee /etc/systemd/system/app.service'  &&  daemon-reload / enable --now / restart (separate ssh calls)`,
      `ssh ${host} 'systemctl is-active app'   # must print: active`,
    ]],
    ["edge.auth", `nginx edge :${EDGE_PORT} -> 127.0.0.1:${cfg.port}; /admin + /api/admin gated by basic auth (fails closed)`, [
      `ssh ${host} 'sudo tee /etc/nginx/htpasswd-admin'   # ADMIN_USER + apr1 hash (openssl)`,
      `ssh ${host} 'sudo tee /etc/nginx/sites-available/app && sudo ln -sf ... sites-enabled/ && sudo nginx -t && sudo systemctl enable --now nginx'`,
    ]],
    ["proxy.pin", "pin the exe.dev proxy to the nginx edge — standalone step, never auto-pick", [
      `ssh exe.dev share port ${cfg.app} ${EDGE_PORT}`,
      ...(cfg.makePublic ? [`ssh exe.dev share set-public ${cfg.app}`] : [`# proxy stays PRIVATE (exe.dev login for everything) — pass --public for a public site`]),
    ]],
    ["verify.live", "4-level check: app, edge bridge, operator plane fails-closed, platform proxy", [
      `ssh ${host} 'curl http://127.0.0.1:${cfg.port}/healthz'                  # L1 app up`,
      `ssh ${host} 'curl http://127.0.0.1:${EDGE_PORT}/healthz'                  # L2 edge bridges`,
      `ssh ${host} 'curl http://127.0.0.1:${EDGE_PORT}/admin'                    # L3 MUST be 401 (and not-401 with creds)`,
      `curl -i https://${host}/                                        # L4 2xx/3xx = routed`,
    ]],
  ];

  console.log(`DRY RUN — provisioning plan for "${cfg.app}" (nothing will be executed)\n`);
  console.log(`  app URL:    https://${host}   (chain: exe.dev :443 -> nginx :${EDGE_PORT} -> app 127.0.0.1:${cfg.port})`);
  console.log(`  visibility: ${cfg.makePublic ? "PUBLIC (anyone; /admin still gated)" : "PRIVATE by default — exe.dev login for everything; pass --public for a public site"}`);
  console.log(`  database:   PlanetScale ${cfg.psOrg}/${db}, branch "${cfg.app}" (isolated)`);
  console.log(`  idea:       ${cfg.idea || "\x1b[33m(none — required for app.generate)\x1b[0m"}\n`);
  for (const [id, what, cmds] of steps) {
    console.log(`${mark(id)} \x1b[35m${id}\x1b[0m — ${what}`);
    for (const c of cmds) console.log(`           \x1b[2m${c}\x1b[0m`);
  }
  console.log(`\nteardown plan:`);
  for (const c of [
    `ssh exe.dev rm ${cfg.app}`,
    `pscale role delete ${db} ${cfg.app} <role-id> --force --successor postgres   # runtime, then migrate`,
    `pscale branch delete ${db} ${cfg.app} --force`,
    `rm state/${cfg.app}.json`,
  ]) console.log(`           \x1b[2m${c}\x1b[0m`);
  console.log(`\nrun it:    npm run provision -- --app ${cfg.app}${cfg.idea ? ` --idea "${cfg.idea}"` : ' --idea "..."'}${cfg.makePublic ? " --public" : ""}`);
}
