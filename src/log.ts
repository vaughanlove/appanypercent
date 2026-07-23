const c = (n: number, s: string) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);

export function info(msg: string) {
  console.log(c(36, "[info] ") + msg);
}
export function step(id: string, msg: string) {
  console.log(c(35, `[step ${id}] `) + msg);
}
export function warn(msg: string) {
  console.warn(c(33, "[WARN] ") + msg);
}
export function notice(msg: string) {
  console.warn(c(33, "[NOTICE] ") + msg);
}

/** Loud, step-attributed failure. The pipeline runs autonomously; never fail quietly. */
export function fatal(stepId: string, msg: string, remedy?: string): never {
  console.error(c(41, `\n[FATAL step=${stepId}] `) + msg);
  if (remedy) console.error(c(33, "[remedy] ") + remedy);
  console.error(
    c(33, "[state] ") +
      "Provisioning state for this app is in state/<app>.json — re-running `provision` resumes at this step; `teardown` cleans up a half-provisioned app.",
  );
  process.exit(1);
}
