#!/usr/bin/env node
// CLI entry: registers tsx so src/*.ts runs directly (no build step), then hands off to the CLI.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
