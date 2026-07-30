import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { classifyToolUse } from "./policy";
import { buildSystemPrompt } from "./prompt";
import {
  sessionFileUrl,
  type ChoiceOption,
  type RobotEvent,
} from "../session/events";
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
  /** Named in the URLs the agent's screenshots are served from. */
  sessionId: string;
  /**
   * Keep a file the agent produced and make it fetchable.
   *
   * The runner does not know whether that means a bucket or a disk, which is
   * the point: it once wrote screenshots straight to a directory, and they
   * stopped being reachable the moment downloads moved to object storage.
   */
  saveFile: (filename: string, bytes: Uint8Array) => Promise<void>;
  onEvent: (event: RobotEvent) => void;
};

export type StartAgentDeps = {
  queryFn?: QueryFn;
};

export type AgentRunner = {
  send(text: string): void;
  approve(requestId: string, approved: boolean): void;
  choose(requestId: string, value: string): void;
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
  const [prefix, _server, ...toolName] = name.split("__");
  return prefix === "mcp" && toolName.length > 0 ? toolName.join("__") : name;
}

/**
 * Adjust what a tool was asked to do before it does it.
 *
 * Playwright MCP hands a screenshot back as an image only when no filename was
 * given; with one it writes the file into its own output directory and returns
 * a path instead. That directory belongs to the MCP process — nobody on our
 * side can reach it — and the picture reaches neither the person who asked for
 * it nor the model that took it, which then describes the page from memory.
 * Dropping the filename is what makes a screenshot an actual screenshot.
 */
function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (shortToolName(toolName) !== "browser_take_screenshot" || !("filename" in input)) {
    return input;
  }
  const { filename: _dropped, ...rest } = input;
  return rest;
}

/** Extensions for the image types the browser tools can return. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type ContentBlock = { type?: string; content?: unknown; source?: unknown };

/** Content blocks of a message, whether it carries prose or structured parts. */
function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
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
  const choices = new Map<
    string,
    {
      options: ChoiceOption[];
      resolve: (choice: ChoiceOption | null) => void;
    }
  >();
  let nextRequestId = 0;
  let nextChoiceId = 0;

  const browserPilot = createSdkMcpServer({
    name: "browserpilot",
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use ask_user_choice whenever the application presents a finite set of values the person must choose between.",
    tools: [
      tool(
        "ask_user_choice",
        "Pause and show an inline selector in BrowserPilot. Open and inspect the application's dropdown first, then pass every available option with its exact value. Use this instead of listing options in prose or asking the person to type one.",
        {
          question: z.string().min(1).max(500),
          options: z
            .array(
              z.object({
                label: z.string().min(1).max(120),
                value: z.string().min(1).max(500),
                description: z.string().max(300).optional(),
              }),
            )
            .min(2)
            .max(50),
        },
        async ({ question, options }) => {
          // Repeated values cannot be distinguished by the UI or safely sent
          // back to the model, so keep the first label for each exact value.
          const seen = new Set<string>();
          const available = options.filter((option) => {
            if (seen.has(option.value)) return false;
            seen.add(option.value);
            return true;
          });

          if (available.length < 2) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "At least two distinct option values are required.",
                },
              ],
            };
          }

          const requestId = `choice_${++nextChoiceId}`;
          opts.onEvent({
            type: "choice_request",
            requestId,
            question,
            options: available,
          });

          const selected = await new Promise<ChoiceOption | null>((resolve) => {
            choices.set(requestId, { options: available, resolve });
          });

          if (!selected) {
            return {
              content: [{ type: "text", text: "The session ended before the user chose." }],
            };
          }

          opts.onEvent({
            type: "choice_resolved",
            requestId,
            value: selected.value,
            label: selected.label,
          });

          return {
            content: [
              {
                type: "text",
                text: `The user selected "${selected.label}" (exact value: "${selected.value}"). Continue using that selection.`,
              },
            ],
          };
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          alwaysLoad: true,
        },
      ),
    ],
  });

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const updatedInput = normalizeToolInput(toolName, toolInput);

    // Classified on what the model actually asked for, not on our rewrite.
    if (classifyToolUse(toolName, toolInput, opts.site.destructivePatterns) === "auto") {
      return { behavior: "allow", updatedInput };
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
      ? { behavior: "allow", updatedInput }
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
      browserpilot: browserPilot,
    },
    canUseTool,
  };

  const session = queryFn({ prompt: input.stream() as AsyncIterable<never>, options });

  let screenshots = 0;

  /**
   * Put a picture a tool returned somewhere the console can fetch it.
   *
   * The bytes go to disk rather than down the socket: a screenshot is a few
   * hundred kilobytes, and base64 in the event stream would sit in the durable
   * transcript for the life of the session and be replayed on every reload.
   */
  async function saveImage(block: ContentBlock): Promise<void> {
    const source = block.source as
      | { type?: string; media_type?: string; data?: string }
      | undefined;
    if (source?.type !== "base64" || !source.data) return;

    const filename = `screenshot-${++screenshots}.${IMAGE_EXTENSIONS[source.media_type ?? ""] ?? "png"}`;
    try {
      await opts.saveFile(filename, Buffer.from(source.data, "base64"));
    } catch (error) {
      opts.onEvent({
        type: "error",
        message: `Could not save a screenshot: ${(error as Error).message}`,
      });
      return;
    }

    opts.onEvent({
      type: "screenshot",
      filename,
      url: sessionFileUrl(opts.sessionId, filename),
    });
  }

  // Pump SDK messages into RobotEvents. Runs until the query closes.
  void (async () => {
    try {
      for await (const message of session as AsyncIterable<unknown>) {
        const msg = message as { type: string; message?: unknown };

        if (msg.type === "assistant") {
          for (const raw of blocksOf(msg.message)) {
            const block = raw as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") {
              opts.onEvent({ type: "agent_text", text: block.text });
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              // The structured selector is its own visible conversation item;
              // a machine-log line immediately before it would say the same
              // thing less clearly.
              if (shortToolName(block.name) === "ask_user_choice") continue;
              opts.onEvent({
                type: "tool_activity",
                tool: shortToolName(block.name),
                summary: summarize(block.name, toolInput),
              });
            }
          }
          continue;
        }

        // Tool results come back as user messages. This is the only place a
        // picture the agent took ever appears, so a pump that read assistant
        // turns alone dropped every screenshot on the floor.
        if (msg.type === "user") {
          for (const block of blocksOf(msg.message)) {
            if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
            for (const part of block.content as ContentBlock[]) {
              if (part?.type === "image") await saveImage(part);
            }
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
    choose(requestId: string, value: string) {
      const pending = choices.get(requestId);
      const selected = pending?.options.find((option) => option.value === value);
      if (!pending || !selected) return;
      choices.delete(requestId);
      pending.resolve(selected);
    },
    async stop() {
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      choices.forEach(({ resolve }) => resolve(null));
      choices.clear();
      input.close();
      await session.interrupt().catch(() => {});
      session.close();
    },
  };
}
