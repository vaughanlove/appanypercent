/**
 * Embedded Pi generation session. Runs INSIDE the app's exe.dev VM (the KVM-isolated VM is the
 * security boundary — Pi has no permission system by design).
 *
 * SDK usage per pi docs/sdk.md + examples/sdk: createAgentSession() with DefaultResourceLoader,
 * cwd = ~/app, so the project-local .pi/ (settings, extensions, skills) synced by the provisioner
 * is discovered. Pi core is not modified; everything custom is in .pi/.
 */
import { appendFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const idea = Buffer.from(process.env.IDEA_B64 ?? "", "base64").toString("utf8");
const port = process.env.PORT ?? "8080";
if (!idea) {
  console.error("[runner] FATAL: IDEA_B64 not set");
  process.exit(1);
}

const cwd = process.env.HOME + "/app";
process.chdir(cwd);
const logFile = `${cwd}/.agentrunner/session.log`;

const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
await resourceLoader.reload();

const { session } = await createAgentSession({
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
    appendFileSync(logFile, event.assistantMessageEvent.delta);
  }
});

const prompt = `Build a full-stack web app in the current directory (~/app). App idea:

${idea}

Hard requirements (the "exe-app", "planetscale-prisma", and "exe-auth" skills have details — read them):
- Node.js + npm. package.json MUST have a "start" script that runs the production server.
- The HTTP server MUST listen on process.env.PORT (currently ${port}) on 127.0.0.1 (an nginx edge
  fronts it). Never hardcode a port.
- Expose GET /healthz returning 200 "ok" (unauthenticated).
- AUTH IS NOT OPTIONAL: mount every admin/dashboard/bulk-data/export/destructive route under
  /admin or /api/admin and gate it on ADMIN_USER/ADMIN_PASSWORD from the environment (see exe-auth
  skill). Never emit an unauthenticated route that returns other users' data.
- Persistence: PlanetScale Postgres via Prisma pinned EXACTLY at 6.19.3 (prisma + @prisma/client).
  Write prisma/schema.prisma (source of truth) with url = env("DATABASE_URL") and
  directUrl = env("DIRECT_DATABASE_URL"). No prisma.config.ts. Do NOT run migrations — the harness does.
- Per-user identity (if needed): "Login with exe" headers per the exe-auth skill. Never password
  auth or third-party OAuth.
- Read config ONLY from environment variables (a ~/app/.env exists; never print or commit it).
- Install dependencies you add (npm install) and make sure "npm start" works.`;

try {
  await session.prompt(prompt);
  console.log("\n[runner] generation session complete");
} catch (err) {
  console.error("\n[runner] FATAL: Pi session failed:", err?.message ?? err);
  process.exit(1);
} finally {
  session.dispose();
}
