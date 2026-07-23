/**
 * `npm run doctor` — preflight for the whole pipeline. Runs every check (never stops at the
 * first failure), prints ✓/✗/! with a copy-pasteable remedy, exits non-zero if any REQUIRED
 * check fails. This is the first command a new operator should run.
 */
import { run } from "./run.ts";

type Level = "ok" | "fail" | "warn";
interface Check {
  name: string;
  level: Level;
  detail: string;
  remedy?: string;
}

const results: Check[] = [];
const ok = (name: string, detail: string) => results.push({ name, level: "ok", detail });
const fail = (name: string, detail: string, remedy: string) => results.push({ name, level: "fail", detail, remedy });
const warn = (name: string, detail: string, remedy: string) => results.push({ name, level: "warn", detail, remedy });

function have(bin: string): boolean {
  return run("doctor", "sh", ["-c", `command -v ${bin}`], { allowFail: true }).status === 0;
}

export async function doctor(): Promise<void> {
  console.log("appanypercent doctor — checking everything provisioning needs\n");

  // 1. Local tooling ---------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20
    ? ok("node", `v${process.versions.node}`)
    : fail("node", `v${process.versions.node} (< 20)`, "Install Node 20+ (nvm install 20).");

  for (const bin of ["ssh", "rsync"]) {
    have(bin) ? ok(bin, "installed") : fail(bin, "not found in PATH", `Install ${bin} (apt/brew install ${bin}).`);
  }

  // 2. exe.dev (the API is SSH) ----------------------------------------------
  const exe = run("doctor", "ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "exe.dev", "whoami", "--json"], {
    allowFail: true,
    timeoutMs: 20_000,
  });
  if (exe.status === 0) {
    let who = exe.stdout.trim().slice(0, 60);
    try {
      const j = JSON.parse(exe.stdout);
      who = j.email ?? j.user ?? who;
    } catch { /* keep raw */ }
    ok("exe.dev", `authenticated as ${who}`);
  } else {
    fail(
      "exe.dev",
      "`ssh exe.dev whoami` failed",
      "Run `ssh exe.dev` once interactively to register your SSH key (see https://exe.dev), then re-run doctor.",
    );
  }

  // 3. PlanetScale CLI + org/database ----------------------------------------
  const psOrg = process.env.PS_ORG ?? "";
  const psDb = process.env.PS_DATABASE ?? "";
  if (!have("pscale")) {
    fail("pscale", "not found in PATH", "Install the PlanetScale CLI: https://planetscale.com/docs/cli — then `pscale auth login` or set PLANETSCALE_SERVICE_TOKEN_ID/_TOKEN.");
  } else if (!psOrg || !psDb) {
    fail(
      "planetscale config",
      `PS_ORG=${psOrg || "(unset)"} PS_DATABASE=${psDb || "(unset)"}`,
      "export PS_ORG=<org> PS_DATABASE=<postgres-db> — create the parent Postgres database once in the PlanetScale dashboard (leave `main` empty).",
    );
  } else {
    const db = run("doctor", "pscale", ["database", "show", psDb, "--org", psOrg, "--format", "json"], {
      allowFail: true,
      timeoutMs: 30_000,
    });
    if (db.status === 0) {
      ok("planetscale", `auth OK, database ${psOrg}/${psDb} exists`);
      const br = run("doctor", "pscale", ["branch", "list", psDb, "--org", psOrg, "--format", "json"], {
        allowFail: true,
        timeoutMs: 30_000,
      });
      let hasMain = false;
      try {
        const parsed = JSON.parse(br.stdout);
        const list = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
        hasMain = list.some((b: any) => b?.name === "main");
      } catch { /* fallthrough */ }
      hasMain
        ? ok("branch main", `parent branch exists on ${psDb}`)
        : warn("branch main", "no `main` branch found", `Per-app branches are created --from main. Check: pscale branch list ${psDb} --org ${psOrg}`);
    } else {
      fail(
        "planetscale",
        `cannot access ${psOrg}/${psDb}`,
        "Auth: `pscale auth login`, or export PLANETSCALE_SERVICE_TOKEN_ID + PLANETSCALE_SERVICE_TOKEN. Also verify the database exists and is a Postgres database.",
      );
    }
  }

  // 4. MCP verification token (optional but recommended) ----------------------
  if (process.env.PLANETSCALE_API_TOKEN ?? process.env.PLANETSCALE_SERVICE_TOKEN) {
    try {
      const { callTool } = await import("./mcp.ts");
      await callTool("planetscale_list_organizations", {});
      ok("mcp", "hosted PlanetScale MCP server reachable & authenticated");
    } catch (err: any) {
      warn(
        "mcp",
        `MCP call failed: ${String(err?.message ?? err).slice(0, 120)}`,
        "The db.promote step will SKIP schema verification (non-fatal). See PLACEHOLDER-VERIFY note in src/mcp.ts.",
      );
    }
  } else {
    warn(
      "mcp",
      "PLANETSCALE_API_TOKEN not set",
      "export PLANETSCALE_API_TOKEN=<service token> to enable off-VM schema verification (db.promote). Optional; step degrades to a NOTICE.",
    );
  }

  // 5. LLM key for Pi ----------------------------------------------------------
  const llmVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  const found = llmVars.filter((k) => process.env[k]);
  found.length > 0
    ? ok("llm key", `${found.join(", ")} set (forwarded to the VM for the Pi generation step)`)
    : warn(
        "llm key",
        "no LLM API key in environment",
        "export ANTHROPIC_API_KEY=... (or pass --llm-env NAME). Without it, app.generate will fail — or use exe.dev's LLM integration.",
      );

  // Report ---------------------------------------------------------------------
  const icon = { ok: "\x1b[32m ✓ \x1b[0m", warn: "\x1b[33m ! \x1b[0m", fail: "\x1b[31m ✗ \x1b[0m" };
  console.log();
  for (const r of results) {
    console.log(`${icon[r.level]}${r.name.padEnd(20)} ${r.detail}`);
    if (r.remedy) console.log(`${"".padEnd(23)}\x1b[2m→ ${r.remedy}\x1b[0m`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log();
  if (fails > 0) {
    console.log(`\x1b[31m${fails} required check(s) failed\x1b[0m — fix the remedies above, then re-run: npm run doctor`);
    process.exit(1);
  }
  console.log(
    warns > 0
      ? `\x1b[33mready with ${warns} warning(s)\x1b[0m — you can provision; warned features degrade gracefully.`
      : "\x1b[32mall checks passed\x1b[0m — you're ready.",
  );
  console.log('\nnext:  npm run plan      -- --app demo --idea "a guestbook"   (dry run, prints every command)');
  console.log('       npm run provision -- --app demo --idea "a guestbook" --public');
}
