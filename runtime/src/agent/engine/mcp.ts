import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { playwrightMcpCliPath } from "../mcp-path";
import type { McpToolSet } from "./tools";

/**
 * The browser tools for one session.
 *
 * Each session gets its own MCP process pointed at its own browser's CDP
 * endpoint — that is what keeps two people's sessions from typing into each
 * other's pages.
 */

export type BrowserToolsOptions = {
  cdpEndpoint: string;
  /**
   * node, not bun: playwright's connectOverCDP never completes its WebSocket
   * handshake under Bun, and MCP responds by quietly starting its own browser —
   * one with no session cookie and none of our pages.
   */
  nodeBin?: string;
};

export type BrowserTools = {
  tools: McpToolSet;
  close: () => Promise<void>;
};

export async function connectBrowserTools(opts: BrowserToolsOptions): Promise<BrowserTools> {
  const client = await createMCPClient({
    transport: new StdioClientTransport({
      command: opts.nodeBin ?? "node",
      args: [playwrightMcpCliPath(), "--cdp-endpoint", opts.cdpEndpoint, "--caps", "pdf"],
      // The MCP process inherits our environment for PATH and HOME, but must
      // not inherit anything that points at a model provider: it has no reason
      // to talk to one, and a stray key in a subprocess is a key that leaks.
      env: providerFreeEnv(),
    }),
  });

  return {
    tools: (await client.tools()) as unknown as McpToolSet,
    close: () => client.close(),
  };
}

const PROVIDER_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
];

function providerFreeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROVIDER_ENV_KEYS.includes(key)) env[key] = value;
  }
  return env;
}
