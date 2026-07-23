import { vmRun, vmHost } from "./exedev.ts";
import { fatal, info } from "./log.ts";
import type { Config } from "./config.ts";

/**
 * Two-level liveness check that makes port-contract failures diagnosable, never silent:
 *   level 1 (in-VM):   is the app listening on the contracted PORT?
 *   level 2 (external): does the exe.dev HTTPS proxy route to it?
 * A private proxy answers with a redirect to exe.dev login — that still proves routing,
 * so 2xx/3xx both count. Connection errors / 502-style responses fail loudly.
 */
export async function verifyLive(cfg: Config): Promise<void> {
  // Level 1: app itself, inside the VM.
  const local = vmRun(
    "verify.live",
    cfg.app,
    `curl -sf -o /dev/null -m 10 http://localhost:${cfg.port}/healthz || curl -sf -o /dev/null -m 10 http://localhost:${cfg.port}/`,
    { allowFail: true },
  );
  if (local.status !== 0) {
    fatal(
      "verify.live",
      `App is NOT listening on the contracted port :${cfg.port} inside the VM (port contract violated).`,
      `ssh ${vmHost(cfg.app)} 'tail -50 ~/app/app.log; ss -tlnp' — the app must bind process.env.PORT (${cfg.port}).`,
    );
  }
  info(`level 1 OK: app answers on localhost:${cfg.port} inside the VM`);

  // Level 2: through the exe.dev HTTPS proxy.
  const url = `https://${vmHost(cfg.app)}/`;
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
    info(`level 2 OK: ${url} answered ${status} (3xx = private proxy login redirect — routing works)`);
  } else {
    fatal(
      "verify.live",
      `Proxy check failed for ${url} (last status: ${status || "connection error"}) even though the app is up on :${cfg.port}.`,
      `Check the proxy target: ssh exe.dev share show ${cfg.app} — expected port ${cfg.port}. Re-pin with: ssh exe.dev share port ${cfg.app} ${cfg.port}`,
    );
  }
}
