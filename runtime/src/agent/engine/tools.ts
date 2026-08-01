import { tool, type ToolSet } from "ai";
import { z } from "zod/v4";
import type { WireFormat } from "@browserpilot/core";
import { classifyToolUse } from "../policy";
import {
  normalizeToolInput,
  qualifyToolName,
  shortToolName,
  summarize,
} from "../tool-display";
import { toolOutputContent, type CapturedImage, type ToolOutcome } from "./messages";
import type { ChoiceOption, RobotEvent } from "../../session/events";

/**
 * The browser tools, wrapped so that we run them.
 *
 * Under the Agent SDK the tools were the SDK's and we could only answer yes or
 * no through `canUseTool`. Owning execution makes three things that were
 * awkward simply ordinary code: the screenshot filename is stripped by
 * rewriting the arguments, the approval gate is an awaited promise, and an
 * image the tool returned is intercepted on its way past — saved for the
 * console, and shaped for whichever API the model speaks.
 */

export type ToolDeps = {
  /** How this model wants its tool results shaped. */
  format: WireFormat;
  /** Whether it can read an image at all. */
  vision: boolean;
  destructivePatterns: string[] | null;
  emit: (event: RobotEvent) => void;
  /** Ask the person. Resolves false when they decline or the session ends. */
  requestApproval: (tool: string, summary: string) => Promise<boolean>;
  /** Keep an image the agent produced and announce it. */
  onImage: (image: CapturedImage) => Promise<void>;
  /** Set once a download has landed; every later browser call is refused. */
  completedDownload: () => string | undefined;
  /** Collects images for the hoist. Only used by OpenAI-format providers. */
  collectImage: (image: CapturedImage) => void;
};

/** What an MCP tool call returns, in the shape the MCP client gives us. */
type McpResult = {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

/**
 * Read an MCP result into text plus at most one image.
 *
 * More than one image in a single result has never been observed from the
 * browser tools, and carrying several would mean deciding which the following
 * prose refers to — so the first wins and the rest are noted.
 */
export function readMcpResult(toolName: string, result: unknown): ToolOutcome {
  const { content } = (result ?? {}) as McpResult;
  if (!Array.isArray(content)) {
    return { text: typeof result === "string" ? result : JSON.stringify(result ?? null) };
  }

  const texts: string[] = [];
  let image: CapturedImage | undefined;
  let extraImages = 0;

  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part?.type === "image" && typeof part.data === "string") {
      if (image) extraImages++;
      else image = { toolName, mediaType: part.mimeType ?? "image/png", data: part.data };
    }
  }

  if (extraImages > 0) texts.push(`[${extraImages} further image(s) omitted]`);

  return {
    // A tool that returned only an image still needs words: an empty result
    // reads to a model as a call that did nothing.
    text: texts.join("\n") || (image ? "Screenshot taken." : "(no output)"),
    image,
  };
}

/**
 * Wrap one MCP tool.
 *
 * `callTool` is the raw call; everything around it is policy, presentation and
 * the image path.
 */
function wrapTool(
  server: string,
  name: string,
  description: string,
  inputSchema: unknown,
  callTool: (args: Record<string, unknown>) => Promise<unknown>,
  deps: ToolDeps,
) {
  const qualified = qualifyToolName(server, name);
  const short = shortToolName(qualified);

  return tool({
    description,
    inputSchema: inputSchema as never,
    async execute(rawInput: unknown) {
      const input = (rawInput ?? {}) as Record<string, unknown>;

      // A browser download is the terminal result for this turn. Enforced here
      // rather than in the prompt: otherwise a model keeps inspecting network
      // logs and clicking the same button while the file is already on screen.
      const downloaded = deps.completedDownload();
      if (downloaded && short.startsWith("browser_")) {
        return {
          text: `${downloaded} has already downloaded. Stop this turn without calling more browser tools.`,
        } satisfies ToolOutcome;
      }

      // Classified on what the model actually asked for, not on our rewrite.
      const classification = classifyToolUse(qualified, input, deps.destructivePatterns);
      if (classification === "deny") {
        return {
          text: "Unsafe arbitrary code execution is disabled. Use browser_snapshot and the visible browser actions.",
        } satisfies ToolOutcome;
      }

      if (classification === "approve") {
        const approved = await deps.requestApproval(short, summarize(qualified, input));
        if (!approved) return { text: "The user declined this action." } satisfies ToolOutcome;
      }

      // Denied unsafe calls and stale calls after a completed download are
      // implementation noise, not useful transcript entries — so this is
      // announced only once the call is actually going to happen.
      deps.emit({ type: "tool_activity", tool: short, summary: summarize(qualified, input) });

      const result = await callTool(normalizeToolInput(qualified, input));
      const outcome = readMcpResult(short, result);

      if (outcome.image) {
        await deps.onImage(outcome.image);
        if (deps.vision && deps.format === "openai") deps.collectImage(outcome.image);
      }

      return outcome;
    },
    toModelOutput({ output }: { output: unknown }) {
      return {
        type: "content" as const,
        value: toolOutputContent(output as ToolOutcome, deps.format, deps.vision),
      };
    },
  });
}

/** The MCP tool definitions we need, in the shape the client exposes them. */
export type McpToolSet = Record<
  string,
  { description?: string; inputSchema: unknown; execute: (args: never) => Promise<unknown> }
>;

/** Every browser tool, wrapped. */
export function wrapMcpTools(server: string, tools: McpToolSet, deps: ToolDeps): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    wrapped[name] = wrapTool(
      server,
      name,
      definition.description ?? name,
      definition.inputSchema,
      (args) => definition.execute(args as never),
      deps,
    );
  }
  return wrapped;
}

export type ChoiceDeps = {
  emit: (event: RobotEvent) => void;
  /** Show the selector and wait. Resolves null if the session ends first. */
  ask: (question: string, options: ChoiceOption[]) => Promise<ChoiceOption | null>;
};

/**
 * The one tool that is ours rather than the browser's.
 *
 * It does not touch the target site; it parks the agent while BrowserPilot
 * renders a real selector. Models otherwise list options in prose and ask the
 * person to type one back, which is both slower and easy to get wrong.
 */
export function choiceTool(deps: ChoiceDeps) {
  return tool({
    description:
      "Pause and show an inline selector in BrowserPilot. Open and inspect the application's dropdown first, then pass every available option with its exact value. Use this instead of listing options in prose or asking the person to type one.",
    inputSchema: z.object({
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
    }),
    async execute({ question, options }) {
      // Repeated values cannot be distinguished by the UI or safely sent back
      // to the model, so keep the first label for each exact value.
      const seen = new Set<string>();
      const available = options.filter((option) => {
        if (seen.has(option.value)) return false;
        seen.add(option.value);
        return true;
      });

      if (available.length < 2) {
        return { text: "At least two distinct option values are required." } satisfies ToolOutcome;
      }

      const selected = await deps.ask(question, available);
      if (!selected) {
        return { text: "The session ended before the user chose." } satisfies ToolOutcome;
      }

      return {
        text: `The user selected "${selected.label}" (exact value: "${selected.value}"). Continue using that selection.`,
      } satisfies ToolOutcome;
    },
    toModelOutput({ output }: { output: unknown }) {
      return {
        type: "content" as const,
        value: [{ type: "text" as const, text: (output as ToolOutcome).text }],
      };
    },
  });
}
