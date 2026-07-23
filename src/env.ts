/**
 * Load ./.env (repo root) into process.env at CLI startup. Real environment always wins —
 * .env only fills gaps. Written by fresh-install.sh; gitignored; chmod 0600.
 * Tiny parser on purpose: KEY=VALUE lines, optional single/double quotes, # comments.
 */
import { readFileSync, existsSync } from "node:fs";

export function loadDotEnv(): string[] {
  const path = new URL("../.env", import.meta.url).pathname;
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}
