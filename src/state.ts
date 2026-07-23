import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { info } from "./log.ts";

/**
 * Durable per-app provisioning record. This lives in the HARNESS repo (not on the VM disk):
 * VMs are disposable; everything needed to resume/teardown is here or re-derivable from PlanetScale.
 * NOTE: contains connection strings (chmod'd 0600) — state/ is gitignored.
 */
export interface AppState {
  app: string;
  createdAt: string;
  hostname?: string; // <app>.exe.xyz
  port?: number;
  branchId?: string;
  roles?: { migrate?: { id: string; name: string }; runtime?: { id: string; name: string } };
  urls?: { direct?: string; pooled?: string };
  /** Operator-plane credentials (HARNESS-2): enforced at the nginx edge + in-app. */
  admin?: { user: string; password: string };
  steps: Record<string, { done: boolean; at: string; note?: string }>;
}

const dir = new URL("../state/", import.meta.url).pathname;
const file = (app: string) => `${dir}${app}.json`;

export function loadState(app: string): AppState {
  mkdirSync(dir, { recursive: true });
  if (existsSync(file(app))) return JSON.parse(readFileSync(file(app), "utf8"));
  return { app, createdAt: new Date().toISOString(), steps: {} };
}

export function saveState(s: AppState) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(s.app), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function deleteState(app: string) {
  rmSync(file(app), { force: true });
}

export function stepDone(s: AppState, id: string): boolean {
  return s.steps[id]?.done === true;
}

export function markDone(s: AppState, id: string, note?: string) {
  s.steps[id] = { done: true, at: new Date().toISOString(), note };
  saveState(s);
  info(`step ${id}: done${note ? ` (${note})` : ""}`);
}
