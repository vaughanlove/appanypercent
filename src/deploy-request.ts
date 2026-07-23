/**
 * "Open and merge the deploy request via the PlanetScale MCP server."
 *
 * ======================= DOCUMENTED PLATFORM GAP — READ ME =======================
 * As of the doc snapshot in PLAN.md §0:
 *   1. PlanetScale Postgres has NO deploy requests. /docs/postgres/branching:
 *      "Since PlanetScale Postgres branches don't use deploy requests like in Vitess, you make
 *       schema changes directly on each branch" ... "There's currently no automated way to merge
 *       schema changes between PlanetScale Postgres branches."
 *      /docs/cli/deploy-request: "not currently available for Postgres database clusters."
 *   2. The hosted PlanetScale MCP server exposes NO branch-create/deploy-request/merge tools
 *      (its 16 documented tools are list/get/query/insights/docs-search).
 *
 * Consequence for this architecture: each app's branch IS its isolated durable database, Prisma
 * applies DDL directly over the direct (5432) connection, and there is nothing to merge into main.
 *
 * What this step DOES do, using real, documented MCP tools:
 *   - fetches the branch schema via `planetscale_get_branch_schema` and asserts every model in
 *     schema.prisma is present — an off-VM, control-plane confirmation that the migration landed.
 *
 * If PlanetScale ships deploy requests for Postgres (and MCP tools for them), implement them in
 * openAndMergeDeployRequest() below. Until then it is a clearly-marked placeholder that logs a
 * NOTICE — it does not invent tool names.
 * =================================================================================
 */
import { getBranchSchema } from "./mcp.ts";
import { fatal, info, notice } from "./log.ts";
import type { Config } from "./config.ts";

export async function verifySchemaViaMcp(cfg: Config, expectedTables: string[]): Promise<void> {
  notice(
    "Postgres deploy requests are not available on PlanetScale (see src/deploy-request.ts header). " +
      "Running MCP schema verification instead; the app branch is the production database.",
  );
  const schema = await getBranchSchema(cfg.psOrg, cfg.psDatabase, cfg.app);
  if (schema === undefined) {
    notice("MCP verification skipped (no PLANETSCALE_API_TOKEN or MCP unreachable). Migration was still applied and verified locally by prisma exit codes.");
    return;
  }
  const lower = schema.toLowerCase();
  const missing = expectedTables.filter((t) => !lower.includes(t.toLowerCase()));
  if (missing.length > 0) {
    fatal(
      "db.promote",
      `MCP branch schema is missing expected tables: ${missing.join(", ")}\nSchema returned:\n${schema.slice(0, 3000)}`,
      "The Prisma migration may have targeted the wrong branch/URL. Check DIRECT_DATABASE_URL in the VM's ~/app/.env.",
    );
  }
  info(`MCP schema verification passed (${expectedTables.length} tables present on branch ${cfg.app}).`);
}

/** PLACEHOLDER: Vitess-style branch->DR->merge flow. Not available for Postgres per current docs. */
export async function openAndMergeDeployRequest(_cfg: Config): Promise<void> {
  notice(
    "PLACEHOLDER: openAndMergeDeployRequest() intentionally unimplemented — PlanetScale Postgres " +
      "has no deploy requests and the MCP server exposes no DR tools (doc citations in file header).",
  );
}
