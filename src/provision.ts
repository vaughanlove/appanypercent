import { randomBytes } from "node:crypto";
import { EDGE_PORT, type Config } from "./config.ts";
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
    // HARNESS-2a: operator-plane credentials, generated here so protection exists BEFORE any
    // app code is generated. Enforced twice: nginx edge (edge.auth step) + in-app (exe-auth skill).
    if (!s.admin) {
      s.admin = { user: "admin", password: randomBytes(18).toString("base64url") };
      saveState(s);
    }
    const env = [
      `# Written by appanypercent provisioner. App code reads ONLY PORT, DATABASE_URL, ADMIN_USER, ADMIN_PASSWORD.`,
      `PORT=${cfg.port}`, // ← app listens on 127.0.0.1:$PORT; nginx edge on :${EDGE_PORT} fronts it
      `DATABASE_URL=${s.urls.pooled}`, // runtime: PgBouncer :6432
      `DIRECT_DATABASE_URL=${s.urls.direct}`, // prisma CLI: direct :5432
      `ADMIN_USER=${s.admin.user}`, // operator plane (admin/data routes) — fails closed
      `ADMIN_PASSWORD=${s.admin.password}`,
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
    // HARNESS-5: flags are version-aware. Prisma 6 (our standard pin): --from-url/--to-schema-datamodel
    // + db execute --url. Prisma 7 (if a generation drifts): config-datasource flags via prisma.config.ts.
    const verOut = vmRun("db.migrate", cfg.app, "cd ~/app && npx prisma --version 2>/dev/null | head -2", { allowFail: true });
    const major = Number(verOut.stdout.match(/(\d+)\.\d+\.\d+/)?.[1] ?? 0);
    if (!major) fatal("db.migrate", `Could not detect Prisma version in ~/app.\n${verOut.stdout}`, `ssh ${s.hostname} 'cd ~/app && npx prisma --version'`);
    info(`detected Prisma major version ${major}`);
    const diffCmd =
      major >= 7
        ? `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --exit-code -o /tmp/migration.sql`
        : `npx prisma migrate diff --from-url "$DIRECT_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script --exit-code -o /tmp/migration.sql`;
    const execCmd =
      major >= 7
        ? `npx prisma db execute --file /tmp/migration.sql`
        : `npx prisma db execute --url "$DIRECT_DATABASE_URL" --file /tmp/migration.sql`;
    const diff = vmRun(
      "db.migrate",
      cfg.app,
      `set -e; cd ~/app; set -a; . ./.env; set +a; ${diffCmd}`,
      { allowFail: true, timeoutMs: 10 * 60 * 1000 },
    );
    if (diff.status === 2) {
      info("schema drift detected — applying migration.sql");
      vmRun(
        "db.migrate",
        cfg.app,
        `set -e; cd ~/app; set -a; . ./.env; set +a; ${execCmd} && npx prisma generate`,
        { timeoutMs: 10 * 60 * 1000 },
      );
    } else if (diff.status === 0) {
      info("database already matches schema.prisma — nothing to apply (idempotent)");
      vmRun("db.migrate", cfg.app, "cd ~/app && npx prisma generate", { timeoutMs: 10 * 60 * 1000 });
    } else {
      // Remedy must be runnable on the DETECTED version (HARNESS-5).
      fatal("db.migrate", `prisma migrate diff failed (exit ${diff.status}).`, `ssh ${s.hostname} 'cd ~/app && set -a && . ./.env && set +a && ${diffCmd.replace(" --exit-code -o /tmp/migration.sql", "")}'`);
    }
    markDone(s, "db.migrate");
  }

  // ── 7. "Deploy request" control — see src/deploy-request.ts (Postgres gap) ─
  if (!stepDone(s, "db.promote")) {
    step("db.promote", "MCP schema verification (Postgres has no deploy requests — see PLAN.md §0.1)");
    await verifySchemaViaMcp(cfg, readSchemaTables(cfg));
    markDone(s, "db.promote");
  }

  // ── 8. Run the app under systemd (HARNESS-3: nohup-over-ssh gets SIGHUP'd / exits 255) ──
  if (!stepDone(s, "app.start")) {
    step("app.start", `installing systemd unit; app binds 127.0.0.1:${cfg.port}`);
    const who = vmRun("app.start", cfg.app, "whoami").stdout.trim();
    const unit = [
      "[Unit]",
      `Description=appanypercent app ${cfg.app}`,
      "After=network.target",
      "",
      "[Service]",
      `User=${who}`,
      `WorkingDirectory=/home/${who}/app`,
      `EnvironmentFile=/home/${who}/app/.env`,
      "ExecStart=/usr/bin/env npm start",
      "Restart=always",
      "RestartSec=2",
      `StandardOutput=append:/home/${who}/app/app.log`,
      `StandardError=append:/home/${who}/app/app.log`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ].join("\n");
    // Separate ssh invocations on purpose — chaining these in one command truncated with exit 255.
    vmRun("app.start", cfg.app, "sudo tee /etc/systemd/system/app.service > /dev/null", { input: unit });
    vmRun("app.start", cfg.app, "sudo systemctl daemon-reload");
    vmRun("app.start", cfg.app, "sudo systemctl enable --now app");
    vmRun("app.start", cfg.app, "sudo systemctl restart app");
    const active = vmRun("app.start", cfg.app, "sleep 3; systemctl is-active app", { allowFail: true });
    if (active.stdout.trim() !== "active") {
      fatal(
        "app.start",
        `systemd unit not active (state: ${active.stdout.trim() || "unknown"}).`,
        `ssh ${s.hostname} 'systemctl status app --no-pager; tail -50 ~/app/app.log'`,
      );
    }
    markDone(s, "app.start", "systemd unit 'app' active, Restart=always");
  }

  // ── 9. nginx edge on :EDGE_PORT (HARNESS-2c + HARNESS-4): bridges the platform port to the
  //      app AND enforces the operator plane (/admin, /api/admin) with basic auth — fails closed
  //      even if generated app code forgot to gate a route.
  if (!stepDone(s, "edge.auth")) {
    step("edge.auth", `nginx :${EDGE_PORT} -> 127.0.0.1:${cfg.port}, admin plane gated by basic auth`);
    if (!s.admin) fatal("edge.auth", "admin credentials missing from state — clear vm.secrets step and re-run");
    vmRun("edge.auth", cfg.app, "command -v nginx >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq nginx)", { timeoutMs: 10 * 60 * 1000 });
    // htpasswd via openssl (apr1 is nginx-compatible); password via stdin, never in argv.
    vmRun("edge.auth", cfg.app, `read -r PW; printf '%s:%s\\n' '${s.admin.user}' "$(openssl passwd -apr1 "$PW")" | sudo tee /etc/nginx/htpasswd-admin > /dev/null; sudo chmod 640 /etc/nginx/htpasswd-admin`, { input: s.admin.password + "\n" });
    const vhost = [
      "server {",
      `  listen ${EDGE_PORT} default_server;`,
      "  server_name _;",
      "  # operator plane: fails closed at the edge regardless of app code (HARNESS-2)",
      "  location ~ ^/(admin|api/admin)(/|$) {",
      '    auth_basic "operator";',
      "    auth_basic_user_file /etc/nginx/htpasswd-admin;",
      `    proxy_pass http://127.0.0.1:${cfg.port};`,
      "    proxy_set_header Host $host;",
      "  }",
      "  location / {",
      `    proxy_pass http://127.0.0.1:${cfg.port};`,
      "    proxy_set_header Host $host;",
      "  }",
      "}",
    ].join("\n");
    vmRun("edge.auth", cfg.app, "sudo tee /etc/nginx/sites-available/app > /dev/null", { input: vhost });
    vmRun("edge.auth", cfg.app, "sudo ln -sf /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app");
    vmRun("edge.auth", cfg.app, "sudo rm -f /etc/nginx/sites-enabled/default");
    vmRun("edge.auth", cfg.app, "sudo nginx -t");
    vmRun("edge.auth", cfg.app, "sudo systemctl enable --now nginx");
    vmRun("edge.auth", cfg.app, "sudo systemctl reload nginx");
    markDone(s, "edge.auth", `nginx :${EDGE_PORT} -> :${cfg.port}, /admin gated`);
  }

  // ── 10. Pin the exe.dev proxy — STANDALONE idempotent step (HARNESS-4: must run even when an
  //       earlier app step failed on a previous attempt; never rely on the platform's auto-pick).
  if (!stepDone(s, "proxy.pin")) {
    step("proxy.pin", `ssh exe.dev share port ${cfg.app} ${EDGE_PORT}`);
    setProxyPort(cfg.app, EDGE_PORT);
    if (cfg.makePublic) setPublic(cfg.app);
    markDone(s, "proxy.pin", `exe.dev :443 -> VM :${EDGE_PORT} (nginx) -> 127.0.0.1:${cfg.port} (app)`);
  }

  // ── 11. Verify live (incl. HARNESS-2 auth check: /admin must 401 unauthenticated) ───────
  step("verify.live", `verifying https://${s.hostname}`);
  await verifyLive(cfg);
  markDone(s, "verify.live");

  info(`\n✅ ${cfg.app} is live: https://${s.hostname}  (chain: exe.dev :443 -> nginx :${EDGE_PORT} -> app :${cfg.port}; DB branch ${cfg.psDatabase}/${cfg.app})`);
  info(`   operator plane: https://${s.hostname}/admin — user "${s.admin?.user}", password in state/${cfg.app}.json`);
  if (!cfg.makePublic) info("Proxy is PRIVATE (exe.dev login required for everything). Re-run with --public or: ssh exe.dev share set-public " + cfg.app);
}
