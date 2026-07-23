/**
 * Minimal client for the hosted PlanetScale MCP server (Streamable HTTP).
 * Server URL and tool names verified from https://planetscale.com/docs/connect/mcp:
 *   https://mcp.pscale.dev/mcp/planetscale
 * Headless auth (documented): "Export PLANETSCALE_API_TOKEN environment variable as your service
 * token to bypass browser OAuth."
 *
 * PLACEHOLDER-VERIFY: the docs say to use a service token via PLANETSCALE_API_TOKEN for headless
 * use, but do not spell out the HTTP header for the hosted server. We send it as
 * `Authorization: Bearer <token>` (standard MCP HTTP auth). If the server rejects it, this module
 * fails loudly with the response body.
 */
import { warn } from "./log.ts";

const MCP_URL = "https://mcp.pscale.dev/mcp/planetscale";

let nextId = 1;
let sessionId: string | undefined;

async function rpc(method: string, params: unknown): Promise<any> {
  const token = process.env.PLANETSCALE_API_TOKEN ?? process.env.PLANETSCALE_SERVICE_TOKEN;
  if (!token) throw new Error("PLANETSCALE_API_TOKEN (service token) not set — required for MCP verification");
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 1000)}`);
  // Streamable HTTP may answer as plain JSON or a one-event SSE stream.
  const jsonText = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  const msg = JSON.parse(jsonText);
  if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
  return msg.result;
}

async function ensureInitialized() {
  if (sessionId) return;
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "appanypercent-provisioner", version: "0.1.0" },
  });
  // notifications/initialized (no id expected; best-effort)
  try {
    await rpc("notifications/initialized", {});
  } catch {
    /* some servers 202/ignore this on POST; harmless */
  }
}

/** Call a documented PlanetScale MCP tool, e.g. planetscale_get_branch_schema. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  await ensureInitialized();
  const result = await rpc("tools/call", { name, arguments: args });
  const texts = (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text);
  if (result?.isError) throw new Error(`MCP tool ${name} returned error: ${texts.join("\n").slice(0, 2000)}`);
  return texts.join("\n");
}

export async function getBranchSchema(org: string, database: string, branch: string): Promise<string | undefined> {
  try {
    return await callTool("planetscale_get_branch_schema", { organization: org, database, branch });
  } catch (err: any) {
    warn(`MCP schema fetch failed (non-fatal, see src/mcp.ts): ${err.message}`);
    return undefined;
  }
}
