import type { Config } from "./config.ts";
import { loadState, saveState, stepDone, markDone } from "./state.ts";
import { createVm, setProxyPort, setPublic, vmRun, vmHost } from "./exedev.ts";
import { createBranch, createRole, connectionUrl } from "./planetscale.ts";
import { generateApp, readSchemaTables } from "./pi-generate.ts";
import { verifySchemaViaMcp } from "./deploy-request.ts";
import { verifyLive } from "./verify.ts";
import { fatal, info, step, warn } from "./log.ts";

export async function provision(cfg: Config): Promise<void> {
  const s = loadState(cfg.app);
  s.hostname = vmHost(cfg.app);
  s.port = cfg.port;
  saveState(s);

  // ── 1. VM ────────────────────────────────────────────────────────────────
  if (!stepDone(s, "vm.create")) {
    step("vm.create", `creating exe.dev VM "${cfg.app}"`);
    createVm(cfg.app);
    markDone(s, "vm.create", s.hostname);
  }

  // ── 2. Isolated PlanetScale branch (the app's durable database) ──────────
  if (!stepDone(s, "db.branch")) {
    step("db.branch", `creating PlanetScale branch ${cfg.psDatabase}/${cfg.app}`);
    createBranch(cfg, cfg.app);
    markDone(s, "db.branch");
  }

  // ── 3. Per-app, least-privilege roles (never shared, never the default role)
  if (!stepDone(s, "db.roles")) {
    step("db.roles", "creating migrate (DDL) + runtime (DML-only) roles");
    const migrate = createRole(cfg, cfg.app, `${cfg.app}-migrate`, "postgres");
    const runtime = createRole(cfg, cfg.app, `${cfg.app}-runtime`, "pg_read_all_data,pg_write_all_data");
    s.roles = {
      migrate: { id: migrate.id, name: `${cfg.app}-migrate` },
      runtime: { id: runtime.id, name: `${cfg.app}-runtime` },
    };
    s.urls = {
      direct: connectionUrl(migrate, 5432), // migrations only
      pooled: connectionUrl(runtime, 6432), // app runtime via PgBouncer
    };
    saveState(s);
    markDone(s, "db.roles");
  }

  // ── 4. Secrets into the VM (~/app/.env, 0600). Blast radius: this VM+branch.
  if (!stepDone(s, "vm.secrets")) {
    step("vm.secrets", "writing ~/app/.env on the VM");
    if (!s.urls?.direct || !s.urls?.pooled) fatal("vm.secrets", "connection URLs missing from state — rerun db.roles (delete its entry in state file)");
    const llm = cfg.llmEnvVars
      .map((k) => (process.env[k] ? `${k}=${process.env[k]}` : null))
      .filter(Boolean) as string[];
    if (llm.length === 0) {
      warn(
        `None of [${cfg.llmEnvVars.join(", ")}] set on this machine — Pi on the VM will have no model provider. ` +
          "Set the key or use exe.dev's LLM integration (https://exe.dev/docs/integrations-llm).",
      );
    }
    const env = [
      `# Written by appanypercent provisioner. App code reads ONLY PORT and DATABASE_URL.`,
      `PORT=${cfg.port}`, // ← the app<->proxy port contract, single source of truth
      `DATABASE_URL=${s.urls.pooled}`, // runtime: PgBouncer :6432
      `DIRECT_DATABASE_URL=${s.urls.direct}`, // prisma CLI: direct :5432
      ...llm,
      "",
    ].join("\n");
    vmRun("vm.secrets", cfg.app, "umask 077 && mkdir -p ~/app && cat > ~/app/.env && chmod 600 ~/app/.env", { input: env });
    markDone(s, "vm.secrets");
  }

  // ── 5. Generate app + schema.prisma with Pi (inside the VM) ──────────────
  if (!stepDone(s, "app.generate")) {
    step("app.generate", "running embedded Pi with .pi/ extensions + skills");
    generateApp(cfg);
    markDone(s, "app.generate");
  }

  // ── 6. Prisma migrations from the VM over the DIRECT connection ──────────
  if (!stepDone(s, "db.migrate")) {
    step("db.migrate", "prisma migrate diff -> db execute (direct :5432)");
    // Prisma v7 (docs): CLI reads datasource from prisma.config.ts, which we require to use
    // env("DIRECT_DATABASE_URL"). --exit-code: 0 = in sync, 2 = changes generated.
    const diff = vmRun(
      "db.migrate",
      cfg.app,
      `set -e; cd ~/app; set -a; . ./.env; set +a; npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code -o /tmp/migration.sql`,
      { allowFail: true, timeoutMs: 10 * 60 * 1000 },
    );
    if (diff.status === 2) {
      info("schema drift detected — applying migration.sql");
      vmRun(
        "db.migrate",
        cfg.app,
        `set -e; cd ~/app; set -a; . ./.env; set +a; npx prisma db execute --file /tmp/migration.sql && npx prisma generate`,
        { timeoutMs: 10 * 60 * 1000 },
      );
    } else if (diff.status === 0) {
      info("database already matches schema.prisma — nothing to apply (idempotent)");
      vmRun("db.migrate", cfg.app, "cd ~/app && npx prisma generate", { timeoutMs: 10 * 60 * 1000 });
    } else {
      fatal("db.migrate", `prisma migrate diff failed (exit ${diff.status}).`, `ssh ${s.hostname} 'cd ~/app && npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma'`);
    }
    markDone(s, "db.migrate");
  }

  // ── 7. "Deploy request" control — see src/deploy-request.ts (Postgres gap) ─
  if (!stepDone(s, "db.promote")) {
    step("db.promote", "MCP schema verification (Postgres has no deploy requests — see PLAN.md §0.1)");
    await verifySchemaViaMcp(cfg, readSchemaTables(cfg));
    markDone(s, "db.promote");
  }

  // ── 8. Start app + pin the proxy port EXPLICITLY ──────────────────────────
  if (!stepDone(s, "app.start")) {
    step("app.start", `starting app on :${cfg.port} and pointing the exe.dev proxy at it`);
    vmRun(
      "app.start",
      cfg.app,
      `set -e; cd ~/app; set -a; . ./.env; set +a; (pkill -f 'npm start' || true); sleep 1; nohup npm start > ~/app/app.log 2>&1 & sleep 3; pgrep -f 'npm start' >/dev/null || (tail -50 ~/app/app.log; exit 1)`,
    );
    setProxyPort(cfg.app, cfg.port); // never rely on auto-pick
    if (cfg.makePublic) setPublic(cfg.app);
    markDone(s, "app.start", `proxy -> :${cfg.port}`);
  }

  // ── 9. Verify live ─────────────────────────────────────────────────────────
  step("verify.live", `verifying https://${s.hostname}`);
  await verifyLive(cfg);
  markDone(s, "verify.live");

  info(`\n✅ ${cfg.app} is live: https://${s.hostname}  (proxy -> VM :${cfg.port}, DB branch ${cfg.psDatabase}/${cfg.app})`);
  if (!cfg.makePublic) info("Proxy is PRIVATE (exe.dev login required). Re-run with --public or: ssh exe.dev share set-public " + cfg.app);
}
