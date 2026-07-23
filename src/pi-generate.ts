/**
 * Step app.generate — run Pi INSIDE the app's VM.
 *
 * Pi has no built-in permission system; the exe.dev KVM-isolated VM is the security boundary,
 * so the agent never runs on the control machine. Pi is embedded via its SDK
 * (@earendil-works/pi-coding-agent, pinned in agent/package.json + package-lock.json — no fork;
 * all customization lives in this repo's .pi/ extensions and skills, loaded via .pi/settings.json).
 */
import { vmRun, vmSync } from "./exedev.ts";
import { fatal, info } from "./log.ts";
import type { Config } from "./config.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

export function generateApp(cfg: Config): void {
  if (!cfg.idea) {
    fatal("app.generate", "No --idea provided and app not yet generated.", 'Re-run with --idea "your app idea".');
  }

  // 1) Ensure node is available in the VM (exeuntu is Ubuntu-based; loud if this fails).
  vmRun(
    "app.generate",
    cfg.app,
    "command -v node >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm)",
    { timeoutMs: 10 * 60 * 1000 },
  );

  // 2) Ship the agent runner + our .pi extensions/skills into ~/app.
  vmRun("app.generate", cfg.app, "mkdir -p ~/app");
  // NOTE: only vm/.pi is shipped — the operator-side .pi/ (provisioning tools) must NEVER
  // reach a VM: the VM has no pscale/exe.dev credentials and that's the security boundary.
  vmSync("app.generate", cfg.app, `${repoRoot}agent`, "~/app/.agentrunner");
  vmSync("app.generate", cfg.app, `${repoRoot}vm/.pi`, "~/app/.pi");

  // 3) Install the pinned Pi dependency on the VM.
  vmRun("app.generate", cfg.app, "cd ~/app/.agentrunner && npm install --no-audit --no-fund", {
    timeoutMs: 15 * 60 * 1000,
  });

  // 4) Run the generation session. Secrets/PORT come from ~/app/.env (written in vm.secrets).
  info("Running Pi generation session on the VM (this is the long step)...");
  const idea = Buffer.from(cfg.idea, "utf8").toString("base64"); // avoid shell-quoting hazards
  vmRun(
    "app.generate",
    cfg.app,
    `set -e; cd ~/app; set -a; . ./.env; set +a; IDEA_B64='${idea}' node .agentrunner/runner.mjs`,
    { timeoutMs: 60 * 60 * 1000 },
  );

  // 5) Contract check: the generated app must exist and declare a start script + schema.prisma.
  const check = vmRun(
    "app.generate",
    cfg.app,
    "test -f ~/app/package.json && test -f ~/app/prisma/schema.prisma && test -f ~/app/prisma.config.ts && node -e \"const p=require(process.env.HOME+'/app/package.json'); if(!p.scripts||!p.scripts.start) process.exit(1)\"",
    { allowFail: true },
  );
  if (check.status !== 0) {
    fatal(
      "app.generate",
      "Generated app is missing package.json with a `start` script, prisma/schema.prisma, or prisma.config.ts.",
      `Inspect the VM: ssh ${cfg.app}.exe.xyz — the Pi session log is at ~/app/.agentrunner/session.log`,
    );
  }
}

/** Parse model/table names out of schema.prisma on the VM, for MCP verification later. */
export function readSchemaTables(cfg: Config): string[] {
  const { stdout } = vmRun("db.promote", cfg.app, "cat ~/app/prisma/schema.prisma");
  const tables: string[] = [];
  for (const m of stdout.matchAll(/^\s*model\s+(\w+)/gm)) tables.push(m[1]);
  for (const m of stdout.matchAll(/@@map\("([^"]+)"\)/g)) tables.push(m[1]);
  return [...new Set(tables)];
}
