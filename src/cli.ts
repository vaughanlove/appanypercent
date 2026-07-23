#!/usr/bin/env tsx
import { loadConfig } from "./config.ts";
import { provision } from "./provision.ts";
import { teardown } from "./teardown.ts";
import { verifyLive } from "./verify.ts";
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

const usage = `usage:
  npm run provision -- --app <name> --idea "<app idea>" [--port 8080] [--public] [--region <r>] [--org <ps-org>] [--database <ps-db>]
  npm run teardown  -- --app <name>
  npm run verify    -- --app <name> [--port 8080]
  npm run status    -- --app <name>

env: PS_ORG, PS_DATABASE, PLANETSCALE_SERVICE_TOKEN(_ID), PLANETSCALE_API_TOKEN (MCP), ANTHROPIC_API_KEY (or --llm-env)`;

switch (cmd) {
  case "provision":
    await provision(loadConfig(args));
    break;
  case "teardown":
    await teardown(loadConfig(args));
    break;
  case "verify":
    await verifyLive(loadConfig(args));
    break;
  case "status": {
    const app = String(args.app ?? "");
    if (!app) fatal("status", "--app required");
    console.log(JSON.stringify(loadState(app), null, 2));
    break;
  }
  default:
    console.error(usage);
    process.exit(2);
}
