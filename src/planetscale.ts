/**
 * PlanetScale adapter (Postgres product), via the official `pscale` CLI.
 * Verified against: /docs/cli/branch, /docs/cli/role, /docs/postgres/connecting/roles,
 * /docs/postgres/connecting/quickstart.
 *
 * Auth: interactive `pscale auth login`, or headless via
 * PLANETSCALE_SERVICE_TOKEN_ID + PLANETSCALE_SERVICE_TOKEN (+ PLANETSCALE_ORG / --org).
 */
import { run, runJson } from "./run.ts";
import { fatal, info, warn } from "./log.ts";
import type { Config } from "./config.ts";

function pscale(stepId: string, args: string[], org: string, opts: { allowFail?: boolean } = {}) {
  return run(stepId, "pscale", [...args, "--org", org, "--format", "json"], opts);
}

export function branchExists(cfg: Config, branch: string): boolean {
  const out = runJson<any>("db.branch", "pscale", [
    "branch", "list", cfg.psDatabase, "--org", cfg.psOrg, "--format", "json",
  ]);
  const list = Array.isArray(out) ? out : out?.data ?? [];
  return list.some((b: any) => b?.name === branch);
}

/** One isolated branch per app == that app's durable database (Postgres branches are isolated DBs). */
export function createBranch(cfg: Config, branch: string): void {
  if (branchExists(cfg, branch)) {
    info(`branch ${branch} already exists — skipping (idempotent)`);
    return;
  }
  const args = ["branch", "create", cfg.psDatabase, branch, "--from", "main", "--wait"];
  if (cfg.psRegion) args.push("--region", cfg.psRegion);
  pscale("db.branch", args, cfg.psOrg);
}

export function deleteBranch(cfg: Config, branch: string): void {
  pscale("db.branch.delete", ["branch", "delete", cfg.psDatabase, branch, "--force"], cfg.psOrg, { allowFail: true });
}

export interface RoleCred {
  id: string;
  name: string;
  username: string; // documented format: {role}.{branch_id}
  password: string; // documented prefix: pscale_pw_
  host: string; // documented format: {id+region}.horizon.psdb.cloud
}

/**
 * PLACEHOLDER-VERIFY: `pscale role create ... --format json` returns a role object, but the docs
 * do not specify its exact JSON field names. We extract defensively and fail LOUDLY, printing the
 * keys actually received, so a shape mismatch is a 30-second fix rather than a silent bug.
 */
function extractRoleCred(stepId: string, raw: any): RoleCred {
  const pick = (obj: any, keys: string[]) => keys.map((k) => obj?.[k]).find((v) => typeof v === "string" && v.length > 0);
  const id = pick(raw, ["id", "role_id", "public_id"]);
  const name = pick(raw, ["name", "role_name"]);
  const username = pick(raw, ["username", "user", "access_username"]);
  const password = pick(raw, ["password", "access_password"]);
  const host = pick(raw, ["access_host_url", "host", "hostname", "database_host"]);
  if (!id || !username || !password || !host) {
    fatal(
      stepId,
      `Could not extract role credentials from pscale JSON output. Keys received: ${JSON.stringify(Object.keys(raw ?? {}))}\nFull object (password redacted): ${JSON.stringify({ ...raw, password: "<redacted>" }, null, 2)}`,
      "Update extractRoleCred() in src/planetscale.ts to match the current pscale output shape.",
    );
  }
  return { id, name: name ?? "", username, password, host };
}

/**
 * Least-privilege, per-app roles (never the default `postgres` role — docs forbid app use of it):
 *  - migrate: inherits `postgres` (needed for DDL — per docs, pg_write_all_data does NOT grant
 *    CREATE TABLE). Scoped to this app's isolated branch only.
 *  - runtime: pg_read_all_data + pg_write_all_data. Data-plane only.
 */
export function createRole(cfg: Config, branch: string, name: string, inherited: string): RoleCred {
  const out = runJson<any>("db.roles", "pscale", [
    "role", "create", cfg.psDatabase, branch, name,
    "--inherited-roles", inherited,
    "--org", cfg.psOrg, "--format", "json",
  ]);
  return extractRoleCred("db.roles", out?.data ?? out);
}

export function deleteRole(cfg: Config, branch: string, roleId: string): void {
  // Successor required when the role owns objects (docs: usual successor is `postgres`).
  const r = pscale(
    "db.roles.delete",
    ["role", "delete", cfg.psDatabase, branch, roleId, "--force", "--successor", "postgres"],
    cfg.psOrg,
    { allowFail: true },
  );
  if (r.status !== 0) warn(`role ${roleId} delete returned ${r.status} (may already be gone)`);
}

/**
 * Connection strings, verified format (/docs/postgres/connecting/quickstart):
 * host {id+region}.horizon.psdb.cloud, user {role}.{branch_id}, TLS required.
 * Port 5432 = direct (migrations/DDL) · port 6432 = PgBouncer (app runtime).
 */
export function connectionUrl(cred: RoleCred, port: 5432 | 6432, dbname = "postgres"): string {
  const u = encodeURIComponent(cred.username);
  const p = encodeURIComponent(cred.password);
  return `postgresql://${u}:${p}@${cred.host}:${port}/${dbname}?sslmode=verify-full`;
}
