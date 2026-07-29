import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  query,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { classifyToolUse } from "./policy";
import { buildSystemPrompt } from "./prompt";
import type { RobotEvent } from "../session/events";
import type { TargetSite } from "../store";

export type QueryFn = (params: { prompt: AsyncIterable<never>; options?: Options }) => Query;

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

export type StartAgentOptions = {
  cdpEndpoint: string;
  /** The target this agent drives, loaded from the database. */
  site: TargetSite;
  model: string;
  env: Record<string, string>;
  /** Node binary used to run the MCP server. Override when it isn't on PATH. */
  nodeBin?: string;
  onEvent: (event: RobotEvent) => void;
};

export type StartAgentDeps = {
  queryFn?: QueryFn;
};

export type AgentRunner = {
  send(text: string): void;
  approve(requestId: string, approved: boolean): void;
  stop(): Promise<void>;
};

/** Async queue that turns runner.send() calls into the SDK's streaming input. */
function createInputStream() {
  const pending: string[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;

  return {
    push(text: string) {
      pending.push(text);
      waiters.splice(0).forEach((wake) => wake());
    },
    close() {
      closed = true;
      waiters.splice(0).forEach((wake) => wake());
    },
    async *stream(): AsyncGenerator<unknown> {
      for (;;) {
        const text = pending.shift();
        if (text !== undefined) {
          yield {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: "",
          };
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

/**
 * Environment for the agent subprocess.
 *
 * The SDK replaces the subprocess environment with whatever `env` holds rather
 * than merging it into `process.env`, so passing the credential alone would
 * strip `PATH` and `HOME` — and the MCP server's `node` would stop resolving.
 * Inherit the real environment, drop any ambient Anthropic credential so it
 * cannot outrank the configured one, then apply ours.
 */
function subprocessEnv(credential: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  delete inherited.CLAUDE_CODE_OAUTH_TOKEN;
  delete inherited.ANTHROPIC_API_KEY;
  return { ...inherited, ...credential };
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__playwright__/, "");
}

/**
 * A one-line description of what a tool call will actually do.
 *
 * This is the entire basis on which someone approves or denies, so it has to
 * carry the specifics. An approval card reading only "browser_evaluate" asks
 * the user to vouch for code they cannot see, which teaches them to approve
 * reflexively — worse than not asking at all.
 */
function summarize(toolName: string, input: Record<string, unknown>): string {
  const short = shortToolName(toolName);

  // Arbitrary code: show it, trimmed to one readable line.
  const code = ["function", "fn", "expression", "script", "pageFunction"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string");
  if (code) {
    const flattened = code.replace(/\s+/g, " ").trim();
    return `${short}: ${flattened.length > 160 ? `${flattened.slice(0, 157)}…` : flattened}`;
  }

  const url = typeof input.url === "string" ? input.url : undefined;
  if (url) return `${short}: ${url}`;

  const target = typeof input.element === "string" ? input.element : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;
  if (target && text) return `${short}: ${target} — "${text.slice(0, 60)}"`;
  if (target) return `${short}: ${target}`;

  // Anything else: show whatever scalar arguments it carries.
  const scalars = Object.entries(input)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .slice(0, 3);
  return scalars.length > 0 ? `${short}: ${scalars.join(", ")}` : short;
}

export async function startAgent(
  opts: StartAgentOptions,
  deps: StartAgentDeps = {},
): Promise<AgentRunner> {
  const queryFn = deps.queryFn ?? (query as unknown as QueryFn);
  const input = createInputStream();
  const approvals = new Map<string, (approved: boolean) => void>();
  let nextRequestId = 0;

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (classifyToolUse(toolName, toolInput, opts.site.destructivePatterns) === "auto") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const requestId = `apr_${++nextRequestId}`;
    opts.onEvent({
      type: "approval_request",
      requestId,
      tool: shortToolName(toolName),
      summary: summarize(toolName, toolInput),
    });

    const approved = await new Promise<boolean>((resolve) => {
      approvals.set(requestId, resolve);
    });
    approvals.delete(requestId);
    opts.onEvent({ type: "approval_resolved", requestId, approved });

    return approved
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "The user declined this action." };
  };

  const options: Options = {
    model: opts.model,
    env: subprocessEnv(opts.env),
    systemPrompt: buildSystemPrompt(opts.site),
    // The browser is the agent's entire world. Without this the SDK hands it
    // the full Claude Code toolset — Bash, Read, Write, and filesystem access
    // to the runtime host, none of which it has any business touching.
    tools: [],
    strictMcpConfig: true,
    permissionMode: "default",
    mcpServers: {
      playwright: {
        type: "stdio",
        // node, not bun: playwright's connectOverCDP never completes its
        // WebSocket handshake under Bun, and MCP responds by quietly starting
        // its own browser — one with no session cookie and none of our pages.
        command: opts.nodeBin ?? "node",
        args: [playwrightMcpCliPath(), "--cdp-endpoint", opts.cdpEndpoint, "--caps", "pdf"],
        alwaysLoad: true,
      },
    },
    canUseTool,
  };

  const session = queryFn({ prompt: input.stream() as AsyncIterable<never>, options });

  // Pump SDK messages into RobotEvents. Runs until the query closes.
  void (async () => {
    try {
      for await (const message of session as AsyncIterable<unknown>) {
        const msg = message as {
          type: string;
          message?: { content?: Array<Record<string, unknown>> };
        };
        if (msg.type !== "assistant") continue;
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            opts.onEvent({ type: "agent_text", text: block.text });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const toolInput = (block.input ?? {}) as Record<string, unknown>;
            opts.onEvent({
              type: "tool_activity",
              tool: shortToolName(block.name),
              summary: summarize(block.name, toolInput),
            });
          }
        }
      }
    } catch (error) {
      opts.onEvent({ type: "error", message: (error as Error).message });
    }
  })();

  return {
    send(text: string) {
      input.push(text);
    },
    approve(requestId: string, approved: boolean) {
      approvals.get(requestId)?.(approved);
    },
    async stop() {
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      input.close();
      await session.interrupt().catch(() => {});
      session.close();
    },
  };
}
