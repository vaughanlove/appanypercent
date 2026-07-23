/**
 * Operator-side Pi extension: registers the provisioning pipeline as first-class agent tools.
 * This is what makes `appanypercent` an interactive harness rather than just a CLI.
 *
 * Each tool shells out to the same CLI the one-shot commands use (node bin/appanypercent.mjs ...),
 * so behavior, idempotency, and state files are identical whether a human or the agent drives.
 * Output is streamed into the tool result as it happens (provision can run for many minutes).
 *
 * SECURITY: this extension lives in the operator repo's .pi/ and is NEVER shipped to app VMs
 * (VMs get vm/.pi instead — see src/pi-generate.ts). Uses only the public ExtensionAPI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname;

type UpdateCb = ((u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined;

function runCli(
  args: string[],
  signal: AbortSignal | undefined,
  onUpdate: UpdateCb,
): Promise<{ text: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${repoRoot}bin/appanypercent.mjs`, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const push = (chunk: Buffer) => {
      buf += chunk.toString();
      onUpdate?.({ content: [{ type: "text", text: buf.slice(-6000) }], details: {} });
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ text: buf, code: code ?? -1 });
    });
  });
}

function result(text: string, code: number) {
  const tail = text.length > 20_000 ? `…(truncated)…\n${text.slice(-20_000)}` : text;
  return {
    content: [{ type: "text" as const, text: `${tail}\n\n[exit code: ${code}]` }],
    isError: code !== 0,
    details: { exitCode: code },
  };
}

const appName = Type.String({
  description: "App name: lowercase DNS-ish ([a-z0-9-]). Becomes <name>.exe.xyz and the PlanetScale branch name.",
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "provision_app",
    label: "Provision app",
    description:
      "Provision a full app end-to-end: exe.dev VM + isolated PlanetScale Postgres branch + scoped roles, " +
      "generate the app with Pi inside the VM from the idea, run Prisma migrations, pin the proxy port, verify live. " +
      "Idempotent: completed steps are skipped, so re-run after fixing a failure. LONG-RUNNING (minutes).",
    parameters: Type.Object({
      app: appName,
      idea: Type.String({ description: "The app idea, in plain language. Required on first provision of an app." }),
      port: Type.Optional(Type.Number({ description: "App<->proxy port contract (default 8080)" })),
      public: Type.Optional(Type.Boolean({ description: "Make the HTTPS proxy public (default: private, exe.dev login required)" })),
      region: Type.Optional(Type.String({ description: "PlanetScale branch region" })),
    }),
    async execute(_id, p, signal, onUpdate) {
      const args = ["provision", "--app", p.app, "--idea", p.idea];
      if (p.port) args.push("--port", String(p.port));
      if (p.public) args.push("--public");
      if (p.region) args.push("--region", p.region);
      const r = await runCli(args, signal, onUpdate);
      return result(r.text, r.code);
    },
  });

  pi.registerTool({
    name: "teardown_app",
    label: "Teardown app",
    description:
      "Destroy an app completely: exe.dev VM, PlanetScale roles, PlanetScale branch (drops its database!), local state. " +
      "Safe on half-provisioned apps. DESTRUCTIVE and irreversible — confirm with the user before calling unless they explicitly asked.",
    parameters: Type.Object({ app: appName }),
    async execute(_id, p, signal, onUpdate) {
      const r = await runCli(["teardown", "--app", p.app], signal, onUpdate);
      return result(r.text, r.code);
    },
  });

  pi.registerTool({
    name: "app_status",
    label: "App status",
    description: "Show the persisted provisioning state for an app: which of the 9 steps completed, hostname, port, branch/roles.",
    parameters: Type.Object({ app: appName }),
    async execute(_id, p, signal, onUpdate) {
      const r = await runCli(["status", "--app", p.app], signal, onUpdate);
      return result(r.text, r.code);
    },
  });

  pi.registerTool({
    name: "verify_app",
    label: "Verify app",
    description: "Re-run the two-level liveness check: app on its contracted port inside the VM, then through https://<app>.exe.xyz.",
    parameters: Type.Object({
      app: appName,
      port: Type.Optional(Type.Number({ description: "Port contract if not the default 8080" })),
    }),
    async execute(_id, p, signal, onUpdate) {
      const args = ["verify", "--app", p.app];
      if (p.port) args.push("--port", String(p.port));
      const r = await runCli(args, signal, onUpdate);
      return result(r.text, r.code);
    },
  });

  pi.registerTool({
    name: "plan_app",
    label: "Plan (dry run)",
    description: "Dry run: print the exact commands each provisioning step would execute for this app, with done/pending markers. Executes nothing.",
    parameters: Type.Object({
      app: appName,
      idea: Type.Optional(Type.String()),
    }),
    async execute(_id, p, signal, onUpdate) {
      const args = ["plan", "--app", p.app];
      if (p.idea) args.push("--idea", p.idea);
      const r = await runCli(args, signal, onUpdate);
      return result(r.text, r.code);
    },
  });

  pi.registerTool({
    name: "doctor",
    label: "Doctor",
    description: "Preflight every dependency (node/ssh/rsync, exe.dev auth, pscale auth + parent database, MCP token, LLM key, Pi pin consistency). Read-only.",
    parameters: Type.Object({}),
    async execute(_id, _p, signal, onUpdate) {
      const r = await runCli(["doctor"], signal, onUpdate);
      return result(r.text, r.code);
    },
  });
}
