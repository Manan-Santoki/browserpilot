import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { WireFormat } from "@browserpilot/core";
import { buildSystemPrompt } from "../prompt";
import { IMAGE_EXTENSIONS } from "../tool-display";
import { sessionFileUrl, type ChoiceOption, type RobotEvent } from "../../session/events";
import type { AgentRunner, StartAgentOptions } from "../runner";
import { compact } from "./compaction";
import { hoistImages, needsImageHoist, type CapturedImage } from "./messages";
import { connectBrowserTools, type BrowserTools } from "./mcp";
import { choiceTool, wrapMcpTools } from "./tools";

/**
 * The agent loop, driven by us.
 *
 * The contract above it — `AgentRunner` — is unchanged, and deliberately so:
 * the session manager, the browser fleet, the screencast, the console and the
 * mobile app all sit on that interface and none of them should be able to tell
 * which engine is underneath.
 *
 * What changes underneath is the reason for the exercise. Owning message
 * assembly is what lets a screenshot reach a model that speaks OpenAI's format,
 * which is most of the models worth running; see `messages.ts`.
 */

/**
 * How many tool calls one turn may make before we stop it.
 *
 * Generous, because a real task on a slow ERP genuinely takes dozens — the
 * measured MiMo run took thirteen for one report — but finite, because a model
 * that has lost the plot will otherwise click forever at somebody's expense.
 */
const MAX_STEPS = 64;

/**
 * Room for one step's reply.
 *
 * Set explicitly because the Anthropic client caps an *unknown* model id at
 * 4096 — and through a gateway every model id is unknown, so every gateway
 * session would quietly truncate long answers with only a warning on stderr to
 * show for it. 8192 is comfortably inside what every model we offer accepts.
 */
const MAX_OUTPUT_TOKENS = 8192;

export type EngineDeps = {
  /** Injected by tests. Production builds one from the provider settings. */
  model?: LanguageModel;
  connect?: (opts: { cdpEndpoint: string; nodeBin?: string }) => Promise<BrowserTools>;
};

/** Build the provider client for one session's model. */
export function modelFor(opts: {
  model: string;
  format: WireFormat;
  baseUrl?: string;
  headers: Record<string, string>;
}): LanguageModel {
  if (opts.format === "openai") {
    return createOpenAICompatible({
      name: "browserpilot",
      // The client appends `/chat/completions`, so it wants the versioned base
      // — the opposite end of the same normalisation the settings page does.
      baseURL: `${opts.baseUrl ?? "https://api.openai.com"}/v1`,
      headers: opts.headers,
    })(opts.model);
  }

  return createAnthropic({
    baseURL: `${opts.baseUrl ?? "https://api.anthropic.com"}/v1`,
    // Every credential kind is already a header by this point; the SDK's own
    // apiKey handling would only add a second, contradictory one.
    apiKey: "",
    headers: opts.headers,
  })(opts.model);
}

/** Async queue turning `send()` calls into turns, one at a time. */
function createInputQueue() {
  const pending: Array<{ text: string; voiceTaskId?: string }> = [];
  const waiters: Array<() => void> = [];
  let closed = false;

  return {
    push(text: string, voiceTaskId?: string) {
      pending.push({ text, voiceTaskId });
      waiters.splice(0).forEach((wake) => wake());
    },
    close() {
      closed = true;
      waiters.splice(0).forEach((wake) => wake());
    },
    async next(): Promise<{ text: string; voiceTaskId?: string } | null> {
      for (;;) {
        const next = pending.shift();
        if (next) return next;
        if (closed) return null;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

export async function startAiSdkAgent(
  opts: StartAgentOptions,
  deps: EngineDeps = {},
): Promise<AgentRunner> {
  const format: WireFormat = opts.format ?? "anthropic";
  const vision = opts.vision ?? true;

  const model =
    deps.model ??
    modelFor({
      model: opts.model,
      format,
      baseUrl: opts.baseUrl,
      headers: opts.headers ?? {},
    });

  const browser = await (deps.connect ?? connectBrowserTools)({
    cdpEndpoint: opts.cdpEndpoint,
    nodeBin: opts.nodeBin,
  });

  const input = createInputQueue();
  const approvals = new Map<string, (approved: boolean) => void>();
  const choices = new Map<
    string,
    { options: ChoiceOption[]; resolve: (choice: ChoiceOption | null) => void }
  >();

  let nextRequestId = 0;
  let nextChoiceId = 0;
  let screenshots = 0;
  let completedDownload: string | undefined;
  let interruptedForDownload = false;
  let interruptedByUser = false;
  let stopped = false;
  let currentTurn: AbortController | undefined;
  let activeVoiceTaskId: string | undefined;

  /** Images awaiting the hoist, cleared once carried into a message. */
  let pendingImages: CapturedImage[] = [];

  const emit = (event: RobotEvent) => {
    opts.onEvent(activeVoiceTaskId ? { ...event, voiceTaskId: activeVoiceTaskId } : event);
  };

  /**
   * Put a picture a tool returned somewhere the console can fetch it.
   *
   * The bytes go to storage rather than down the socket: a screenshot is a few
   * hundred kilobytes, and base64 in the event stream would sit in the durable
   * transcript for the life of the session and be replayed on every reload.
   */
  async function saveImage(image: CapturedImage): Promise<void> {
    const filename = `screenshot-${++screenshots}.${IMAGE_EXTENSIONS[image.mediaType] ?? "png"}`;
    try {
      await opts.saveFile(filename, Buffer.from(image.data, "base64"));
    } catch (error) {
      emit({ type: "error", message: `Could not save a screenshot: ${(error as Error).message}` });
      return;
    }
    emit({ type: "screenshot", filename, url: sessionFileUrl(opts.sessionId, filename) });
  }

  const tools: ToolSet = {
    ...wrapMcpTools("playwright", browser.tools, {
      format,
      vision,
      destructivePatterns: opts.site.destructivePatterns,
      emit,
      requestApproval: async (toolName, summary) => {
        const requestId = `apr_${++nextRequestId}`;
        emit({ type: "approval_request", requestId, tool: toolName, summary });
        const approved = await new Promise<boolean>((resolve) => {
          approvals.set(requestId, resolve);
        });
        approvals.delete(requestId);
        emit({ type: "approval_resolved", requestId, approved });
        return approved;
      },
      onImage: saveImage,
      completedDownload: () => completedDownload,
      collectImage: (image) => pendingImages.push(image),
    }),
    ask_user_choice: choiceTool({
      emit,
      ask: async (question, options) => {
        const requestId = `choice_${++nextChoiceId}`;
        emit({ type: "choice_request", requestId, question, options });

        const selected = await new Promise<ChoiceOption | null>((resolve) => {
          choices.set(requestId, { options, resolve });
        });

        if (selected) {
          emit({
            type: "choice_resolved",
            requestId,
            value: selected.value,
            label: selected.label,
          });
        }
        return selected;
      },
    }),
  };

  const messages: ModelMessage[] = [];
  const system = buildSystemPrompt(opts.site);

  async function runTurn(text: string): Promise<void> {
    messages.push({ role: "user", content: text });
    pendingImages = [];

    const controller = new AbortController();
    currentTurn = controller;

    let failure: string | undefined;
    let produced: ModelMessage[] = [];

    try {
      const result = streamText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
        prepareStep: ({ messages: soFar }) => {
          // Two jobs, both of which the Agent SDK used to do out of sight:
          // carry any image the last step's tools produced into a message this
          // provider can actually read, and keep the whole thing inside the
          // context window.
          const carried = needsImageHoist(format) ? pendingImages : [];
          pendingImages = [];
          return { messages: compact(hoistImages(soFar, carried)) };
        },
        onFinish: ({ responseMessages }) => {
          produced = responseMessages;
        },
        onAbort: ({ steps }) => {
          // An aborted run has no final event, so the messages have to be
          // rebuilt from the steps that did complete. Dropping them would lose
          // the work of an interrupted turn, and the next turn would then
          // reference tool calls the model has no record of making.
          produced = steps.flatMap((step) => step.response.messages);
        },
        onError: ({ error }) => {
          failure = (error as Error).message;
        },
      });

      for await (const part of result.stream) {
        // Text deltas let the live voice layer prepare low-latency narration.
        // The durable transcript still records only complete messages.
        if (part.type === "text-delta") {
          emit({ type: "agent_text_delta", text: part.text });
        } else if (part.type === "text-end") {
          // Nothing: the complete text is emitted from the finished step, so
          // that a message split across deltas arrives as one transcript line.
        } else if (part.type === "error") {
          failure = (part.error as Error)?.message ?? String(part.error);
        }
      }

      for (const message of produced) {
        if (message.role !== "assistant") continue;
        const content = message.content;
        if (typeof content === "string") {
          if (content.trim()) emit({ type: "agent_text", text: content });
          continue;
        }
        for (const part of content) {
          if (part.type === "text" && part.text.trim()) {
            emit({ type: "agent_text", text: part.text });
          }
        }
      }
    } catch (error) {
      // An abort is how interrupt() and downloadCompleted() work, so it is a
      // normal end to a turn rather than something to report.
      if (!controller.signal.aborted) failure = (error as Error).message;
    } finally {
      currentTurn = undefined;
    }

    messages.push(...produced);

    const outcome =
      interruptedForDownload || !failure
        ? interruptedByUser && !interruptedForDownload
          ? "interrupted"
          : "completed"
        : "failed";

    opts.onEvent({
      type: "agent_turn_complete",
      outcome,
      ...(outcome === "failed" && failure ? { detail: failure } : {}),
      ...(activeVoiceTaskId ? { voiceTaskId: activeVoiceTaskId } : {}),
    });

    interruptedForDownload = false;
    interruptedByUser = false;
  }

  // The driver. One turn at a time: a second message sent while the agent is
  // working waits its turn rather than racing the first.
  void (async () => {
    for (;;) {
      const next = await input.next();
      if (!next || stopped) return;
      activeVoiceTaskId = next.voiceTaskId;
      try {
        await runTurn(next.text);
      } catch (error) {
        emit({ type: "error", message: (error as Error).message });
      } finally {
        activeVoiceTaskId = undefined;
      }
    }
  })();

  return {
    send(text: string, voiceTaskId?: string) {
      completedDownload = undefined;
      interruptedForDownload = false;
      input.push(text, voiceTaskId);
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
    async interrupt() {
      interruptedByUser = true;
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      choices.forEach(({ resolve }) => resolve(null));
      choices.clear();
      currentTurn?.abort();
    },
    downloadDetected(filename: string) {
      completedDownload ??= filename;
    },
    downloadCompleted(filename: string) {
      completedDownload ??= filename;
      if (interruptedForDownload) return;
      interruptedForDownload = true;
      // Stop the current tool chain immediately. The loop stays open so the
      // next user message starts a fresh turn with the same history.
      currentTurn?.abort();
    },
    async stop() {
      stopped = true;
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      choices.forEach(({ resolve }) => resolve(null));
      choices.clear();
      input.close();
      currentTurn?.abort();
      await browser.close().catch(() => {});
    },
  };
}
