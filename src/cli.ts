#!/usr/bin/env tsx
import { loadDotEnv } from "./env.ts";
loadDotEnv(); // ./.env (written by fresh-install.sh) fills env gaps; real env wins

import { loadConfig } from "./config.ts";
import { loadState } from "./state.ts";
import { fatal } from "./log.ts";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const usage = `${bold("appanypercent")} — app idea -> live <name>.exe.xyz backed by an isolated PlanetScale Postgres branch

${bold("walkthrough (in order):")}
  1. appanypercent setup                                     ${dim("one-time: pscale, exe.dev key, config -> .env, doctor")}
  2. appanypercent plan --app demo --idea "a guestbook"      ${dim("dry run: prints every command, executes nothing")}
  3. appanypercent provision --app demo --idea "a guestbook" --public
  4. open https://demo.exe.xyz
  5. appanypercent teardown --app demo                       ${dim("deletes VM + DB branch + roles; safe on half-provisioned apps")}

${bold("commands:")}
  setup                                        interactive first-time setup (idempotent; wraps fresh-install.sh)
  doctor                                       preflight all dependencies (safe, read-only)
  plan       --app <name> [--idea "..."]       dry-run: show exact commands per step + current state
  provision  --app <name> --idea "..."         create VM + DB branch + roles, generate app with Pi, migrate, go live
             [--port 8080] [--public] [--region <r>] [--org <ps-org>] [--database <ps-db>] [--llm-env KEY1,KEY2]
  verify     --app <name> [--port 8080]        re-run the two-level liveness check
  status     --app <name>                      dump the persisted per-step provisioning state
  teardown   --app <name>                      destroy everything for this app (idempotent)
  update                                       git pull this harness + reinstall deps (picks up Pi pin bumps)

${bold("environment:")} ${dim("(auto-loaded from ./.env — written by fresh-install.sh; real env vars win)")}
  PS_ORG, PS_DATABASE                          PlanetScale org + parent Postgres database (branch parent)
  PLANETSCALE_SERVICE_TOKEN_ID / _TOKEN        headless pscale auth (or \`pscale auth login\`)
  PLANETSCALE_API_TOKEN                        hosted MCP schema verification (optional, warns if absent)
  ANTHROPIC_API_KEY                            LLM key for the in-VM Pi generation step (or --llm-env)

${dim("docs: README.md (quickstart) · RUNBOOK.md (ops) · PLAN.md (design + doc caveats)")}`;

switch (cmd) {
  case "setup": {
    const { spawnSync } = await import("node:child_process");
    const root = new URL("..", import.meta.url).pathname;
    const r = spawnSync("bash", [`${root}fresh-install.sh`], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  case "update": {
    // Pi is a wrapped, pinned dependency — never a fork. Updating the harness (including any
    // Pi pin bump committed upstream) is: git pull + npm install, in both package roots.
    const { spawnSync } = await import("node:child_process");
    const root = new URL("..", import.meta.url).pathname;
    const sh = (c: string, args: string[], cwd = root) => {
      const r = spawnSync(c, args, { cwd, stdio: "inherit" });
      if (r.status !== 0) fatal("update", `${c} ${args.join(" ")} failed (exit ${r.status})`);
    };
    const piVer = async () => {
      try {
        const { readFileSync } = await import("node:fs");
        return JSON.parse(readFileSync(`${root}node_modules/@earendil-works/pi-coding-agent/package.json`, "utf8")).version as string;
      } catch {
        return "?";
      }
    };
    const before = await piVer();
    sh("git", ["pull", "--ff-only"]);
    sh("npm", ["install", "--no-audit", "--no-fund"]);
    const after = await piVer();
    console.log(before === after ? `updated. Pi still pinned at ${after}.` : `updated. Pi ${before} -> ${after} (VM runners get the new pin on next provision).`);
    break;
  }
  case "doctor": {
    const { doctor } = await import("./doctor.ts");
    await doctor();
    break;
  }
  case "plan": {
    // Lenient: allow plan before PS_ORG/PS_DATABASE are configured, with visible placeholders.
    args.org ??= process.env.PS_ORG ?? "<PS_ORG>";
    args.database ??= process.env.PS_DATABASE ?? "<PS_DATABASE>";
    const { plan } = await import("./plan.ts");
    plan(loadConfig(args));
    break;
  }
  case "provision": {
    const { provision } = await import("./provision.ts");
    await provision(loadConfig(args));
    break;
  }
  case "teardown": {
    const { teardown } = await import("./teardown.ts");
    await teardown(loadConfig(args));
    break;
  }
  case "verify": {
    const { verifyLive } = await import("./verify.ts");
    await verifyLive(loadConfig(args));
    break;
  }
  case "status": {
    const app = String(args.app ?? "");
    if (!app) fatal("status", "--app required");
    console.log(JSON.stringify(loadState(app), null, 2));
    break;
  }
  default:
    console.error(usage);
    process.exit(cmd ? 2 : 0);
}
