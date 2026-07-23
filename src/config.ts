import { fatal } from "./log.ts";

export interface Config {
  app: string; // VM name AND PlanetScale branch name
  idea: string;
  port: number; // the app<->proxy port contract (single source of truth)
  psOrg: string;
  psDatabase: string; // one PlanetScale Postgres database; each app = one branch of it
  psRegion?: string;
  makePublic: boolean;
  llmEnvVars: string[]; // env var names forwarded to the VM for Pi (e.g. ANTHROPIC_API_KEY)
}

export const DEFAULT_PORT = 8080;

export function loadConfig(args: Record<string, string | boolean>): Config {
  const app = String(args.app ?? "");
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(app)) {
    fatal("config", `--app must be a lowercase DNS-ish name, got: "${app}"`);
  }
  const psOrg = String(args.org ?? process.env.PS_ORG ?? "");
  const psDatabase = String(args.database ?? process.env.PS_DATABASE ?? "");
  if (!psOrg || !psDatabase) {
    fatal(
      "config",
      "PlanetScale org/database not set.",
      "Set PS_ORG and PS_DATABASE env vars (or --org/--database). Auth: PLANETSCALE_SERVICE_TOKEN_ID + PLANETSCALE_SERVICE_TOKEN, or `pscale auth login`.",
    );
  }
  return {
    app,
    idea: String(args.idea ?? ""),
    port: args.port ? Number(args.port) : DEFAULT_PORT,
    psOrg,
    psDatabase,
    psRegion: args.region ? String(args.region) : undefined,
    makePublic: Boolean(args.public),
    llmEnvVars: String(args["llm-env"] ?? "ANTHROPIC_API_KEY").split(",").filter(Boolean),
  };
}
