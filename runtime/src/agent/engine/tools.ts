import { tool, type ToolSet } from "ai";
import { z } from "zod/v4";
import { redactJobToolInput, substituteJobPlaceholders, type JobPlaceholder, type WireFormat } from "@browserpilot/core";
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
  /** Job sessions enforce the final Submit/Apply gate in runtime code. */
  canSubmit?: () => boolean;
  resolvePlaceholder?: (placeholder: JobPlaceholder) => Promise<unknown>;
  /** Shared across all browser tools in one job session. */
  sensitiveValues?: Set<string>;
};

function rememberSensitive(value: unknown, values: Set<string>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 4) values.add(trimmed);
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length >= 7) {
      values.add(digits);
      if (digits.length > 10) values.add(digits.slice(-10));
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((item) => rememberSensitive(item, values));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>)
    .forEach((item) => rememberSensitive(item, values));
}

function redactSensitive(text: string, values: Set<string>): string {
  let redacted = text;
  const ordered = [...values].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "gi"), "[protected value]");
  }
  return redacted;
}

function rawFormValue(input: Record<string, unknown>): boolean {
  const isProtected = (value: unknown) => typeof value === "string" && /^\{\{BP_(?:SECRET|ANSWER|PROFILE):[^{}]+\}\}$/.test(value);
  if (Object.hasOwn(input, "text") && typeof input.text === "string" && input.text.length > 0 && !isProtected(input.text)) return true;
  if (!Array.isArray(input.fields)) return false;
  return input.fields.some((field) => {
    if (!field || typeof field !== "object") return false;
    const value = (field as Record<string, unknown>).value;
    return typeof value === "string" && value.length > 0 && !isProtected(value);
  });
}

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
      const displayInput = deps.resolvePlaceholder ? redactJobToolInput(input) : input;
      const activitySummary = summarize(qualified, displayInput);

      const attemptsSubmission =
        (short === "browser_click" && /\b(submit|apply|send application|complete application)\b/i.test(String(input.element ?? input.ref ?? ""))) ||
        (short === "browser_press_key" && String(input.key ?? "").toLowerCase() === "enter") ||
        input.submit === true;
      if (attemptsSubmission && deps.canSubmit && !deps.canSubmit()) {
        return { text: "Submit/Apply is blocked until prepare_application_submission returns ok." } satisfies ToolOutcome;
      }

      if (deps.resolvePlaceholder && ["browser_type", "browser_fill_form", "browser_insert_text"].includes(short) && rawFormValue(input)) {
        return { text: "Job form values must come from lookup_candidate, lookup_saved_answer, or a newly saved answer placeholder." } satisfies ToolOutcome;
      }
      if (deps.resolvePlaceholder && short === "browser_evaluate" && /(?:\.value\s*=|dispatchEvent\s*\(|HTMLInputElement|setAttribute\s*\(\s*['\"]value)/i.test(String(input.function ?? input.expression ?? input.code ?? ""))) {
        return { text: "Mutating job form values through browser_evaluate is disabled. Use visible browser actions with protected placeholders." } satisfies ToolOutcome;
      }

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
      let classification = classifyToolUse(qualified, input, deps.destructivePatterns);
      // A job session may upload only opaque, runtime-staged document
      // placeholders. This is part of the user's already-consented automatic
      // application, while ordinary sessions and literal host paths retain
      // the normal approval gate.
      if (
        classification === "approve" &&
        short === "browser_file_upload" &&
        deps.resolvePlaceholder &&
        Array.isArray(input.paths) &&
        input.paths.length > 0 &&
        input.paths.every((value) => typeof value === "string" && /^\{\{BP_DOCUMENT:[^{}]+\}\}$/.test(value))
      ) classification = "auto";
      if (classification === "deny") {
        return {
          text: "Unsafe arbitrary code execution is disabled. Use browser_snapshot and the visible browser actions.",
        } satisfies ToolOutcome;
      }

      if (classification === "approve") {
        const approved = await deps.requestApproval(short, activitySummary);
        if (!approved) return { text: "The user declined this action." } satisfies ToolOutcome;
      }

      // Denied unsafe calls and stale calls after a completed download are
      // implementation noise, not useful transcript entries — so this is
      // announced only once the call is actually going to happen.
      deps.emit({ type: "tool_activity", tool: short, summary: activitySummary });

      const normalized = normalizeToolInput(qualified, input);
      const executable = deps.resolvePlaceholder
        ? await substituteJobPlaceholders(normalized, async (placeholder) => {
          const value = await deps.resolvePlaceholder!(placeholder);
          rememberSensitive(value, deps.sensitiveValues ?? new Set<string>());
          return value;
        }) as Record<string, unknown>
        : normalized;
      const result = await callTool(executable);
      const outcome = readMcpResult(short, result);
      if (deps.sensitiveValues?.size) outcome.text = redactSensitive(outcome.text, deps.sensitiveValues);

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
  const sharedDeps: ToolDeps = deps.resolvePlaceholder && !deps.sensitiveValues
    ? { ...deps, sensitiveValues: new Set<string>() }
    : deps;
  const wrapped: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    wrapped[name] = wrapTool(
      server,
      name,
      definition.description ?? name,
      definition.inputSchema,
      (args) => definition.execute(args as never),
      sharedDeps,
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
