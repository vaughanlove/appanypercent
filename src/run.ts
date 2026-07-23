import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { fatal } from "./log.ts";

export interface RunResult {
  stdout: string;
  status: number;
}

/** Run a command, capturing stdout. Throws (loudly, via caller) on failure unless allowFail. */
export function run(
  stepId: string,
  cmd: string,
  args: string[],
  opts: { input?: string; allowFail?: boolean; allowedExitCodes?: number[]; timeoutMs?: number } = {},
): RunResult {
  const execOpts: ExecFileSyncOptions = {
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"], // stderr streams through for live diagnostics
  };
  try {
    const stdout = execFileSync(cmd, args, execOpts) as unknown as string;
    return { stdout, status: 0 };
  } catch (err: any) {
    const status: number = typeof err?.status === "number" ? err.status : -1;
    const stdout: string = err?.stdout?.toString?.() ?? "";
    if (opts.allowFail || opts.allowedExitCodes?.includes(status)) return { stdout, status };
    fatal(
      stepId,
      `Command failed (exit ${status}): ${cmd} ${args.join(" ")}\n--- stdout ---\n${stdout.slice(-4000)}`,
    );
  }
}

export function runJson<T = any>(stepId: string, cmd: string, args: string[], opts: { input?: string } = {}): T {
  const { stdout } = run(stepId, cmd, args, opts);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    fatal(stepId, `Expected JSON from: ${cmd} ${args.join(" ")}\nGot:\n${stdout.slice(0, 4000)}`);
  }
}
