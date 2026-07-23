/**
 * exe.dev adapter. Per docs, "The exe.dev API is SSH": every control-plane call is
 * `ssh exe.dev <command> --json` (https://exe.dev/docs/api). VM commands run via `ssh <vm>.exe.xyz`.
 */
import { run, runJson } from "./run.ts";
import { info } from "./log.ts";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];

export const vmHost = (app: string) => `${app}.exe.xyz`;

function exe(stepId: string, cmdline: string[], opts: { allowFail?: boolean } = {}) {
  return run(stepId, "ssh", [...SSH_OPTS, "exe.dev", ...cmdline], opts);
}

export function vmExists(app: string): boolean {
  // `ls --json` documented at /docs/cli-ls + /docs/api (returns {vms:[{vm_name,...}]})
  const out = runJson<{ vms?: Array<{ vm_name: string }> }>("vm.lookup", "ssh", [...SSH_OPTS, "exe.dev", "ls", "--json"]);
  return (out.vms ?? []).some((v) => v.vm_name === app);
}

export function createVm(app: string): void {
  if (vmExists(app)) {
    info(`VM ${app} already exists — skipping create (idempotent)`);
    return;
  }
  // /docs/cli-new: `new --name <name> --json`
  exe("vm.create", ["new", "--name", app, "--json"]);
}

export function deleteVm(app: string): void {
  // /docs/cli-rm: `rm <vmname>`
  exe("vm.delete", ["rm", app, "--json"], { allowFail: true });
}

/**
 * The port contract, made explicit: never rely on exe.dev's auto-pick
 * ("prefers 80, falls back to smallest exposed TCP port" — /docs/proxy).
 * /docs/cli-share: `share port <vm> <port>` updates the HTTPS proxy target.
 */
export function setProxyPort(app: string, port: number): void {
  exe("app.start", ["share", "port", app, String(port)]);
}

export function setPublic(app: string): void {
  exe("app.start", ["share", "set-public", app]);
}

/** Run a shell command inside the VM, optionally piping stdin (used to inject secrets). */
export function vmRun(stepId: string, app: string, script: string, opts: { input?: string; allowFail?: boolean; timeoutMs?: number } = {}) {
  return run(stepId, "ssh", [...SSH_OPTS, vmHost(app), script], opts);
}

/** Copy a local directory into the VM (docs/customization: "use ssh, scp, rsync"). */
export function vmSync(stepId: string, app: string, localDir: string, remoteDir: string) {
  run(stepId, "rsync", [
    "-az",
    "--delete",
    "--exclude", "node_modules",
    "-e", `ssh ${SSH_OPTS.join(" ")}`,
    `${localDir}/`,
    `${vmHost(app)}:${remoteDir}/`,
  ]);
}
