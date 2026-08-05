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
import { playwrightMcpCliPath } from "./mcp-path";
import {
  IMAGE_EXTENSIONS,
  normalizeToolInput,
  shortToolName,
  summarize,
} from "./tool-display";
export { playwrightMcpCliPath } from "./mcp-path";
import {
  sessionFileUrl,
  type ChoiceOption,
  type RobotEvent,
} from "../session/events";
import type { TargetSite } from "../store";
import type { WireFormat } from "@browserpilot/core";
import type { ApplicationInventory, JobAnswerType, SubmissionEvidence } from "@browserpilot/core";

export type JobAgentHandlers = {
  applicationId: string;
  systemPrompt: string;
  lookupCandidate: (fields: string[]) => Promise<Record<string, string>>;
  lookupSavedAnswer: (question: { label: string; answerType: JobAnswerType; options: string[] }) => Promise<string | null>;
  getPortalAccount: () => Promise<{ username: string; password: string }>;
  confirmPortalAccount: (verified: boolean) => Promise<void>;
  resetPortalAccount: () => Promise<{ username: string; password: string }>;
  waitForGmailVerification: (afterIso: string) => Promise<{ code?: string; link?: string }>;
  saveAnswer: (question: { label: string; answerType: JobAnswerType; options: string[] }, value: unknown) => Promise<string>;
  getApplicationSchema: (input: { boardToken?: string }) => Promise<Record<string, unknown>>;
  getApplicationDocuments: () => Promise<{ resume: string; coverLetter?: string }>;
  getCoverLetterContext: () => Promise<{ profile: Record<string, unknown>; resumeText: string }>;
  generateCoverLetter: (content: string) => Promise<string>;
  discoverJob: (identity: { externalJobId: string; company?: string; roleTitle?: string; location?: string }) => Promise<{ duplicateOf?: string }>;
  prepareSubmission: (
    inventory: ApplicationInventory,
    context: { manualTakeoverCompleted: boolean },
  ) => Promise<{ ok: boolean; reasons?: string[] }>;
  recordSubmission: (evidence: SubmissionEvidence) => Promise<{ ok: boolean; reason?: string }>;
  recordFailure: (reason: string) => Promise<void>;
  recordAttention: (reason: string) => Promise<void>;
  resolvePlaceholder: (placeholder: import("@browserpilot/core").JobPlaceholder) => Promise<unknown>;
};

export type QueryFn = (params: { prompt: AsyncIterable<never>; options?: Options }) => Query;

export type StartAgentOptions = {
  cdpEndpoint: string;
  /** The target this agent drives, loaded from the database. */
  site: TargetSite;
  model: string;
  env: Record<string, string>;
  /**
   * Which API this model speaks, and whether it can read an image.
   *
   * Both are properties of the model rather than the deployment, and both are
   * load-bearing: the format decides how a screenshot reaches the model at all,
   * and sending an image to one that cannot read it fails the whole turn with a
   * 400 rather than degrading.
   */
  format?: WireFormat;
  vision?: boolean;
  /** Absent means the provider's own API. Used by the AI SDK engine. */
  baseUrl?: string;
  /** Auth headers, already shaped for this provider's credential kind. */
  headers?: Record<string, string>;
  /** Present only for an owner-isolated public job application. */
  job?: JobAgentHandlers;
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
  /**
   * Which loop runs this session.
   *
   * The Agent SDK path is the one that has driven every session so far and
   * remains the default; the AI SDK path is what reaches models served over
   * OpenAI's format. They implement the same `AgentRunner`, so nothing above
   * here can tell them apart — which is exactly what makes switching back a
   * matter of one environment variable rather than a revert.
   */
  engine?: AgentEngine;
};

export type AgentEngine = "agent-sdk" | "sdk";

/** The engine this deployment runs, unless a caller says otherwise. */
export function engineFrom(env: Record<string, string | undefined>): AgentEngine {
  return env.BP_AGENT_ENGINE?.trim() === "sdk" ? "sdk" : "agent-sdk";
}

export type AgentRunner = {
  send(text: string, voiceTaskId?: string): void;
  approve(requestId: string, approved: boolean): void;
  choose(requestId: string, value: string): void;
  answerJobQuestion?(requestId: string, value: string | number | boolean | string[]): void;
  resolveTakeover?(requestId: string, enabled: boolean): void;
  /** Stop the current model turn while keeping the Claude session reusable. */
  interrupt(): Promise<void>;
  /** Block follow-up browser calls as soon as Chromium reports a download. */
  downloadDetected(filename: string): void;
  /** End the current turn once the browser has produced the requested file. */
  downloadCompleted(filename: string): void;
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
 * Inherit the real environment, drop everything that could point the agent at
 * a different provider, then apply ours.
 *
 * The base URL matters as much as the credential here. A developer with
 * `ANTHROPIC_BASE_URL` exported for some other tool would otherwise silently
 * redirect every session's model traffic to it, and the only symptom would be
 * answers that look subtly wrong.
 */
const PROVIDER_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  // We pass the model as an SDK option; an inherited one would only ever be a
  // second, contradictory source of truth.
  "ANTHROPIC_MODEL",
] as const;

function subprocessEnv(provider: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  for (const key of PROVIDER_ENV_KEYS) delete inherited[key];
  return { ...inherited, ...provider };
}

type ContentBlock = { type?: string; content?: unknown; source?: unknown };

/** Content blocks of a message, whether it carries prose or structured parts. */
function blocksOf(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export async function startAgent(
  opts: StartAgentOptions,
  deps: StartAgentDeps = {},
): Promise<AgentRunner> {
  const engine = opts.job ? "sdk" : (deps.engine ?? engineFrom(process.env));
  if (engine === "sdk") {
    // Imported here rather than at the top so a deployment on the old engine
    // never loads the new one's dependencies — including the MCP client, which
    // spawns a subprocess the moment it is constructed.
    const { startAiSdkAgent } = await import("./engine/loop");
    return startAiSdkAgent(opts);
  }

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
  let completedDownload: string | undefined;
  let interruptedForDownload = false;
  let interruptedByUser = false;
  const pendingTurnIds: Array<string | undefined> = [];

  const emit = (event: RobotEvent) => {
    const voiceTaskId = pendingTurnIds[0];
    opts.onEvent(voiceTaskId ? { ...event, voiceTaskId } : event);
  };

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
          emit({
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

          emit({
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
    const short = shortToolName(toolName);

    // A browser download is the terminal result for this turn. This guard is
    // deliberately runtime-enforced rather than prompt-only: otherwise a model
    // can keep inspecting network logs, running code, and clicking the same
    // download button while the first file is already visible to the user.
    if (completedDownload && short.startsWith("browser_")) {
      return {
        behavior: "deny",
        message: `${completedDownload} has already downloaded. Stop this turn without calling more browser tools.`,
      };
    }

    // Classified on what the model actually asked for, not on our rewrite.
    const classification = classifyToolUse(toolName, toolInput, opts.site.destructivePatterns);
    if (classification === "deny") {
      return {
        behavior: "deny",
        message:
          "Unsafe arbitrary code execution is disabled. Use browser_snapshot and the visible browser actions.",
      };
    }
    if (classification === "auto") {
      return { behavior: "allow", updatedInput };
    }

    const requestId = `apr_${++nextRequestId}`;
    emit({
      type: "approval_request",
      requestId,
      tool: shortToolName(toolName),
      summary: summarize(toolName, toolInput),
    });

    const approved = await new Promise<boolean>((resolve) => {
      approvals.set(requestId, resolve);
    });
    approvals.delete(requestId);
    emit({ type: "approval_resolved", requestId, approved });

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
    // Text deltas let the live voice layer prepare low-latency narration. The
    // durable transcript still records only complete assistant messages.
    includePartialMessages: true,
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
      emit({
        type: "error",
        message: `Could not save a screenshot: ${(error as Error).message}`,
      });
      return;
    }

    emit({
      type: "screenshot",
      filename,
      url: sessionFileUrl(opts.sessionId, filename),
    });
  }

  // Pump SDK messages into RobotEvents. Runs until the query closes.
  void (async () => {
    try {
      for await (const message of session as AsyncIterable<unknown>) {
        const msg = message as {
          type: string;
          subtype?: string;
          message?: unknown;
          event?: {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          errors?: string[];
        };

        if (
          msg.type === "stream_event" &&
          msg.event?.type === "content_block_delta" &&
          msg.event.delta?.type === "text_delta" &&
          typeof msg.event.delta.text === "string"
        ) {
          emit({ type: "agent_text_delta", text: msg.event.delta.text });
          continue;
        }

        if (msg.type === "assistant") {
          for (const raw of blocksOf(msg.message)) {
            const block = raw as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") {
              emit({ type: "agent_text", text: block.text });
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              const short = shortToolName(block.name);
              // The structured selector is its own visible conversation item;
              // a machine-log line immediately before it would say the same
              // thing less clearly.
              if (short === "ask_user_choice") continue;
              // Denied unsafe calls and stale calls after a completed download
              // are implementation noise, not useful transcript entries.
              if (
                short === "browser_run_code_unsafe" ||
                (completedDownload && short.startsWith("browser_"))
              ) {
                continue;
              }
              emit({
                type: "tool_activity",
                tool: short,
                summary: summarize(block.name, toolInput),
              });
            }
          }
          continue;
        }

        if (msg.type === "result") {
          const voiceTaskId = pendingTurnIds.shift();
          const outcome =
            interruptedForDownload || msg.subtype === "success"
              ? "completed"
              : interruptedByUser
                ? "interrupted"
                : "failed";
          const detail =
            outcome === "failed" && Array.isArray(msg.errors) ? msg.errors.join("; ") : undefined;
          opts.onEvent({
            type: "agent_turn_complete",
            outcome,
            ...(detail ? { detail } : {}),
            ...(voiceTaskId ? { voiceTaskId } : {}),
          });
          interruptedForDownload = false;
          interruptedByUser = false;
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
      emit({ type: "error", message: (error as Error).message });
    }
  })();

  return {
    send(text: string, voiceTaskId?: string) {
      completedDownload = undefined;
      interruptedForDownload = false;
      pendingTurnIds.push(voiceTaskId);
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
    answerJobQuestion() {},
    resolveTakeover() {},
    async interrupt() {
      interruptedByUser = true;
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      choices.forEach(({ resolve }) => resolve(null));
      choices.clear();
      await session.interrupt();
    },
    downloadDetected(filename: string) {
      completedDownload ??= filename;
    },
    downloadCompleted(filename: string) {
      completedDownload ??= filename;
      if (interruptedForDownload) return;
      interruptedForDownload = true;
      // Stop the current tool chain immediately. The query stays open so the
      // next user message can start a fresh turn in the same session.
      void session.interrupt().catch(() => {});
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
