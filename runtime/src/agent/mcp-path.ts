import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Absolute path to the Playwright MCP CLI inside our own node_modules.
 *
 * Resolving it ourselves — rather than shelling out to `npx @playwright/mcp` —
 * keeps session startup offline and deterministic. On a WSL host `npx` can even
 * resolve to the Windows binary, which cannot read the Linux working directory.
 */
export function playwrightMcpCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}
