import { vmRun, vmHost } from "./exedev.ts";
import { EDGE_PORT, type Config } from "./config.ts";
import { loadState } from "./state.ts";
import { fatal, info, warn } from "./log.ts";

/**
 * Four-level liveness + auth verification. Each level isolates one failure mode so nothing
 * fails silently (port contract) or open (operator plane):
 *   L1  app answers on 127.0.0.1:$PORT inside the VM           (app up?)
 *   L2  nginx edge answers on 127.0.0.1:EDGE_PORT               (bridge up?)
 *   L3  /admin WITHOUT credentials returns 401, WITH returns not-401  (HARNESS-2: fails closed?)
 *   L4  https://<app>.exe.xyz/ answers 2xx/3xx                  (platform proxy routed?)
 */
export async function verifyLive(cfg: Config): Promise<void> {
  const host = vmHost(cfg.app);
  const code = (url: string, extra = "") =>
    vmRun("verify.live", cfg.app, `curl -s -o /dev/null -m 10 -w '%{http_code}' ${extra} ${url}`, { allowFail: true }).stdout.trim();

  // L1: the app itself
  const l1 = code(`http://127.0.0.1:${cfg.port}/healthz`);
  if (!/^2\d\d$/.test(l1)) {
    const l1root = code(`http://127.0.0.1:${cfg.port}/`);
    if (!/^[23]\d\d$/.test(l1root)) {
      fatal(
        "verify.live",
        `L1 FAIL: app not answering on 127.0.0.1:${cfg.port} (healthz=${l1 || "conn-error"}, /=${l1root || "conn-error"}). Port contract violated or app down.`,
        `ssh ${host} 'systemctl status app --no-pager; tail -50 ~/app/app.log; ss -tlnp'`,
      );
    }
  }
  info(`L1 OK: app answers on 127.0.0.1:${cfg.port}`);

  // L2: nginx edge bridge
  const l2 = code(`http://127.0.0.1:${EDGE_PORT}/healthz`);
  if (!/^[23]\d\d$/.test(l2)) {
    fatal(
      "verify.live",
      `L2 FAIL: nginx edge not bridging :${EDGE_PORT} -> :${cfg.port} (got ${l2 || "conn-error"}).`,
      `ssh ${host} 'systemctl status nginx --no-pager; sudo nginx -t; cat /etc/nginx/sites-enabled/app'`,
    );
  }
  info(`L2 OK: nginx edge :${EDGE_PORT} -> :${cfg.port}`);

  // L3: operator plane fails closed (HARNESS-2)
  const admin = loadState(cfg.app).admin;
  const noAuth = code(`http://127.0.0.1:${EDGE_PORT}/admin`);
  if (noAuth !== "401") {
    fatal(
      "verify.live",
      `L3 FAIL: /admin without credentials returned ${noAuth || "conn-error"} — MUST be 401. Operator plane is failing OPEN.`,
      `ssh ${host} 'cat /etc/nginx/sites-enabled/app; ls -l /etc/nginx/htpasswd-admin' — re-run the edge.auth step (clear it in state/${cfg.app}.json).`,
    );
  }
  if (admin) {
    const withAuth = code(`http://127.0.0.1:${EDGE_PORT}/admin`, `-u '${admin.user}:${admin.password}'`);
    if (withAuth === "401" || withAuth === "403") {
      fatal(
        "verify.live",
        `L3 FAIL: /admin WITH the provisioned credentials returned ${withAuth} — operator lockout.`,
        `Credentials are in state/${cfg.app}.json; htpasswd on the VM at /etc/nginx/htpasswd-admin. Clear edge.auth in state and re-run.`,
      );
    }
    info(`L3 OK: /admin is 401 unauthenticated, ${withAuth} with operator credentials`);
  } else {
    warn("L3 partial: /admin is 401 unauthenticated, but no admin credentials in state to positively test (older app?)");
  }

  // L4: through the exe.dev HTTPS proxy
  const url = `https://${host}/`;
  let status = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      status = res.status;
      if (status >= 200 && status < 400) break;
    } catch {
      status = 0;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (status >= 200 && status < 400) {
    info(`L4 OK: ${url} answered ${status} (3xx = private proxy login redirect — routing works)`);
  } else {
    fatal(
      "verify.live",
      `L4 FAIL: ${url} unreachable through the platform proxy (last status: ${status || "connection error"}) though the VM chain is healthy.`,
      `Check the pin: ssh exe.dev share show ${cfg.app} — expected port ${EDGE_PORT}. Re-pin: ssh exe.dev share port ${cfg.app} ${EDGE_PORT}`,
    );
  }
}
