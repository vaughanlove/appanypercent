/**
 * `npm run plan` — dry run. Prints the exact commands each provisioning step will execute for
 * this app, with current state (done/pending) if a state file exists. Executes NOTHING.
 * This is the cheapest way to sanity-check the pipeline and to learn what it does.
 */
import type { Config } from "./config.ts";
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
      `ssh ${host} 'umask 077 && mkdir -p ~/app && cat > ~/app/.env'   # PORT=${cfg.port}, DATABASE_URL, DIRECT_DATABASE_URL, ${cfg.llmEnvVars.join("/")}`,
    ]],
    ["app.generate", "run embedded Pi INSIDE the VM with .pi/ skills + port-contract extension", [
      `rsync agent/ ${host}:~/app/.agentrunner/   &&   rsync .pi/ ${host}:~/app/.pi/`,
      `ssh ${host} 'cd ~/app/.agentrunner && npm install'`,
      `ssh ${host} 'cd ~/app && . ./.env && IDEA_B64=<idea> node .agentrunner/runner.mjs'`,
    ]],
    ["db.migrate", "apply schema.prisma over the DIRECT (:5432) connection, from the VM", [
      `ssh ${host} 'npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code -o /tmp/migration.sql'`,
      `ssh ${host} 'npx prisma db execute --file /tmp/migration.sql'   # only if exit-code was 2 (drift)`,
    ]],
    ["db.promote", "verify applied schema via hosted PlanetScale MCP (Postgres has no deploy requests — PLAN.md §0.1)", [
      `MCP tools/call planetscale_get_branch_schema {org:${cfg.psOrg}, database:${db}, branch:${cfg.app}}`,
    ]],
    ["app.start", "start the app and pin the HTTPS proxy to the contracted port — never auto-pick", [
      `ssh ${host} 'cd ~/app && . ./.env && nohup npm start > ~/app/app.log 2>&1 &'`,
      `ssh exe.dev share port ${cfg.app} ${cfg.port}`,
      ...(cfg.makePublic ? [`ssh exe.dev share set-public ${cfg.app}`] : [`# proxy stays PRIVATE (exe.dev login) — pass --public to open it`]),
    ]],
    ["verify.live", "two-level liveness check (app-down vs proxy-misroute are distinct errors)", [
      `ssh ${host} 'curl -sf http://localhost:${cfg.port}/healthz'`,
      `curl -i https://${host}/    # 2xx/3xx = routed`,
    ]],
  ];

  console.log(`DRY RUN — provisioning plan for "${cfg.app}" (nothing will be executed)\n`);
  console.log(`  app URL:    https://${host}   (proxy -> VM :${cfg.port})`);
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
