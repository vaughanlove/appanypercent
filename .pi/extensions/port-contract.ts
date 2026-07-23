/**
 * Port-contract enforcement extension.
 *
 * The most common first-run failure on exe.dev is an app listening on a port the HTTPS proxy
 * doesn't target. The harness pins the proxy to process.env.PORT — this extension makes it
 * impossible for the agent to silently generate code that violates that contract:
 * it intercepts `write`/`edit` tool calls and BLOCKS content that calls .listen(<literal>)
 * without using process.env.PORT.
 *
 * Uses only the public ExtensionAPI (docs/extensions.md) — no Pi core modification.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODE_FILE = /\.(ts|js|mjs|cjs|tsx|jsx)$/;

function violates(content: string): string | undefined {
  // .listen(3000 ...) with a numeric literal and no env var anywhere near it
  const m = content.match(/\.listen\(\s*(\d{2,5})\b/);
  if (m && !content.includes("process.env.PORT")) {
    return `Found .listen(${m[1]}) with a hardcoded port and no process.env.PORT in the file.`;
  }
  const p = content.match(/(?:const|let|var)\s+(?:PORT|port)\s*=\s*(\d{2,5})\s*[;\n]/);
  if (p && !content.includes("process.env.PORT")) {
    return `Found port assigned to literal ${p[1]} without falling back from process.env.PORT.`;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const path: string = String(event.input?.path ?? "");
    if (!CODE_FILE.test(path)) return;
    const input = event.input as { content?: string; edits?: Array<{ newText: string }> };
    const content: string =
      event.toolName === "write"
        ? String(input?.content ?? "")
        : (input?.edits ?? []).map((e) => e.newText).join("\n");
    const problem = violates(content);
    if (problem) {
      return {
        block: true,
        reason:
          `PORT CONTRACT VIOLATION in ${path}: ${problem} ` +
          `The exe.dev HTTPS proxy is pinned to process.env.PORT — the server MUST use ` +
          "`const port = Number(process.env.PORT)` and listen on 0.0.0.0. Rewrite and retry.",
      };
    }
  });
}
