import { streamText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod/v4";
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
import { validateApplicationInventory, type ApplicationInventory } from "@browserpilot/core";

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
  const jobAnswers = new Map<string, (value: string | number | boolean | string[] | null) => void>();
  const takeovers = new Map<string, (enabled: boolean) => void>();

  let nextRequestId = 0;
  let nextChoiceId = 0;
  let nextJobRequestId = 0;
  let screenshots = 0;
  let completedDownload: string | undefined;
  let interruptedForDownload = false;
  let interruptedByUser = false;
  let stopped = false;
  let manualTakeoverCompleted = false;
  let currentTurn: AbortController | undefined;
  let activeVoiceTaskId: string | undefined;
  let submissionPrepared = false;

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
      canSubmit: opts.job ? () => submissionPrepared : undefined,
      resolvePlaceholder: opts.job?.resolvePlaceholder,
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

  if (opts.job) {
    const job = opts.job;
    tools.lookup_candidate = tool({
      description: "Look up only the candidate fields needed for the visible form. Values are opaque placeholders substituted by the runtime.",
      inputSchema: z.object({ fields: z.array(z.string().min(1).max(120)).min(1).max(30) }),
      execute: async ({ fields }) => ({ text: JSON.stringify(await job.lookupCandidate(fields)) }),
    });
    tools.lookup_saved_answer = tool({
      description: "Look up an exact previously saved answer. Returns only an opaque placeholder; non-identical questions or option sets return no match.",
      inputSchema: z.object({
        question: z.string().min(1).max(5_000),
        answerType: z.enum(["text", "boolean", "number", "date", "single_choice", "multi_choice"]),
        options: z.array(z.string().min(1).max(300)).max(300).default([]),
      }),
      execute: async ({ question, answerType, options }) => ({
        text: JSON.stringify({ placeholder: await job.lookupSavedAnswer({ label: question, answerType, options }) }),
      }),
    });
    tools.get_portal_account = tool({
      description: "Create or retrieve the playbook-scoped portal account. Returned credentials are opaque placeholders, never plaintext.",
      inputSchema: z.object({}),
      execute: async () => ({ text: JSON.stringify(await job.getPortalAccount()) }),
    });
    tools.confirm_portal_account = tool({
      description: "Mark the stored portal credential active only after signup or login is visibly confirmed.",
      inputSchema: z.object({ emailVerified: z.boolean().default(false) }),
      execute: async ({ emailVerified }) => {
        await job.confirmPortalAccount(emailVerified);
        return { text: "The scoped portal credential is active." };
      },
    });
    tools.reset_portal_account = tool({
      description: "When a stored portal credential is rejected, rotate it into a recoverable pending password-reset credential. Returns opaque placeholders.",
      inputSchema: z.object({}),
      execute: async () => ({ text: JSON.stringify(await job.resetPortalAccount()) }),
    });
    tools.wait_for_gmail_verification = tool({
      description: "Wait for a narrowly scoped Gmail verification received after the account action. Returns opaque verification placeholders.",
      inputSchema: z.object({ afterIso: z.string().min(1) }),
      execute: async ({ afterIso }) => ({ text: JSON.stringify(await job.waitForGmailVerification(afterIso)) }),
    });
    tools.request_unseen_answer = tool({
      description: "Pause for an exact unseen application question. Copy the visible/schema label and every option verbatim; never paraphrase or replace options with Yes/No. The answer is encrypted and saved before this call returns.",
      inputSchema: z.object({
        question: z.string().min(1).max(5_000),
        answerType: z.enum(["text", "boolean", "number", "date", "single_choice", "multi_choice"]),
        options: z.array(z.string().min(1).max(300)).max(300).default([]),
      }),
      execute: async ({ question, answerType, options }) => {
        const existing = await job.lookupSavedAnswer({ label: question, answerType, options });
        if (existing !== null) {
          return { text: JSON.stringify({ saved: true, placeholder: existing, source: "existing_exact_answer" }) };
        }
        const requestId = `jobq_${++nextJobRequestId}`;
        emit({ type: "job_question", requestId, applicationId: job.applicationId, question, answerType, ...(options.length ? { options } : {}) });
        emit({ type: "application_status", applicationId: job.applicationId, status: "needs_attention", detail: "A new application question needs an answer" });
        const value = await new Promise<string | number | boolean | string[] | null>((resolve) => jobAnswers.set(requestId, resolve));
        jobAnswers.delete(requestId);
        if (value === null) return { text: "The application stopped before the question was answered." };
        const placeholder = await job.saveAnswer({ label: question, answerType, options }, value);
        return { text: JSON.stringify({ saved: true, placeholder }) };
      },
    });
    tools.get_application_schema = tool({
      description: "Retrieve exact public ATS question labels, required flags, and option values. For an embedded Greenhouse form, read the board token from the page's embed script or iframe `for=` parameter and pass it here. Use the returned wording verbatim.",
      inputSchema: z.object({ boardToken: z.string().regex(/^[a-z0-9_-]{1,100}$/i).optional() }),
      execute: async (input) => ({ text: JSON.stringify(await job.getApplicationSchema(input)) }),
    });
    tools.get_application_documents = tool({
      description: "Return opaque upload placeholders for the selected résumé and generated cover letter, without exposing decrypted paths.",
      inputSchema: z.object({}),
      execute: async () => ({ text: JSON.stringify(await job.getApplicationDocuments()) }),
    });
    tools.get_cover_letter_context = tool({
      description: "Retrieve only the selected résumé text and limited structured profile fields needed to draft a required cover letter.",
      inputSchema: z.object({}),
      execute: async () => ({ text: JSON.stringify(await job.getCoverLetterContext()) }),
    });
    tools.generate_cover_letter = tool({
      description: "Save a generated ATS-friendly PDF cover letter encrypted and associated with this application. Call only when the visible application requires one.",
      inputSchema: z.object({ content: z.string().min(80).max(20_000) }),
      execute: async ({ content }) => ({ text: JSON.stringify({ placeholder: await job.generateCoverLetter(content) }) }),
    });
    tools.record_job_identity = tool({
      description: "Record the portal job ID and visible metadata immediately after discovery. If it matches an existing application, stop instead of relaunching unless reapply was selected.",
      inputSchema: z.object({
        externalJobId: z.string().min(1).max(300),
        company: z.string().max(300).optional(),
        roleTitle: z.string().max(300).optional(),
        location: z.string().max(300).optional(),
      }),
      execute: async (identity) => {
        const result = await job.discoverJob(identity);
        if (result.duplicateOf) {
          emit({ type: "application_status", applicationId: job.applicationId, status: "not_applied", detail: "Duplicate application linked after portal discovery" });
        }
        return { text: JSON.stringify(result) };
      },
    });
    tools.request_manual_takeover = tool({
      description: "Pause for CAPTCHA, device confirmation, non-email MFA, revoked access, or unusual legal language. Never bypass these controls.",
      inputSchema: z.object({ reason: z.string().min(1).max(500) }),
      execute: async ({ reason }) => {
        const requestId = `takeover_${++nextJobRequestId}`;
        emit({ type: "manual_takeover", requestId, applicationId: job.applicationId, reason, active: true });
        emit({ type: "application_status", applicationId: job.applicationId, status: "needs_attention", detail: reason });
        const resumed = await new Promise<boolean>((resolve) => takeovers.set(requestId, resolve));
        takeovers.delete(requestId);
        if (resumed) manualTakeoverCompleted = true;
        emit({ type: "manual_takeover", requestId, applicationId: job.applicationId, reason, active: false });
        return { text: resumed ? "The user returned control. Take a fresh snapshot before continuing." : "The user cancelled manual takeover." };
      },
    });
    tools.prepare_application_submission = tool({
      description: "Provide the complete required-field inventory. A Submit/Apply click is blocked until this returns ok.",
      inputSchema: z.object({
        requiredFields: z.array(z.object({ key: z.string().min(1).max(160), handled: z.boolean() })),
        unresolvedQuestionIds: z.array(z.string()), resumeStaged: z.boolean(), coverLetterRequired: z.boolean(),
        coverLetterStaged: z.boolean(), consentGranted: z.boolean(), unusualLegalLanguage: z.boolean(),
      }),
      execute: async (inventory) => {
        const reviewedInventory = manualTakeoverCompleted && inventory.unusualLegalLanguage
          ? { ...inventory, unusualLegalLanguage: false }
          : inventory;
        const local = validateApplicationInventory(reviewedInventory as ApplicationInventory);
        if (!local.ok) return { text: JSON.stringify(local) };
        const result = await job.prepareSubmission(reviewedInventory as ApplicationInventory, { manualTakeoverCompleted });
        submissionPrepared = result.ok;
        return { text: JSON.stringify(result) };
      },
    });
    tools.record_verified_submission = tool({
      description: "After Submit, record confirmation text, URL, screenshot, or reference ID. Without evidence the application is never marked Applied.",
      inputSchema: z.object({ confirmationText: z.string().max(2000).optional(), confirmationUrl: z.string().url().optional(), screenshotKey: z.string().max(500).optional(), referenceId: z.string().max(500).optional() }),
      execute: async (evidence) => {
        const result = await job.recordSubmission(evidence);
        emit({
          type: "application_status",
          applicationId: job.applicationId,
          status: result.ok ? "applied" : "needs_attention",
          detail: result.ok ? "Submission confirmed" : result.reason,
        });
        return { text: JSON.stringify(result) };
      },
    });
    tools.record_application_failure = tool({
      description: "Record a structured failure or closed job without including form values, credentials, or mailbox content.",
      inputSchema: z.object({ reason: z.string().min(1).max(1000) }),
      execute: async ({ reason }) => {
        if (/\b(?:reCAPTCHA|CAPTCHA|hCaptcha|Turnstile|device confirmation|non-email MFA|multi-factor authentication|two-factor authentication|unusual legal (?:term|language)|revoked Gmail)\b/i.test(reason)) {
          return { text: "This condition requires manual takeover, not a terminal failure. Call request_manual_takeover now." };
        }
        if (/\b(?:candidate profile|candidate data|not configured|selected r[eé]sum[eé].*(?:missing|unavailable)|Gmail verification is unavailable)\b/i.test(reason)) {
          await job.recordAttention(reason);
          emit({ type: "application_status", applicationId: job.applicationId, status: "needs_attention", detail: "Application configuration needs attention" });
          return { text: "The application was paused for configuration instead of being marked failed." };
        }
        await job.recordFailure(reason);
        emit({ type: "application_status", applicationId: job.applicationId, status: "failed", detail: "Structured failure recorded" });
        return { text: "Failure recorded." };
      },
    });
  }

  const messages: ModelMessage[] = [];
  const system = opts.job?.systemPrompt ?? buildSystemPrompt(opts.site);

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
    answerJobQuestion(requestId, value) {
      jobAnswers.get(requestId)?.(value);
    },
    resolveTakeover(requestId, enabled) {
      takeovers.get(requestId)?.(enabled);
    },
    async interrupt() {
      interruptedByUser = true;
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      choices.forEach(({ resolve }) => resolve(null));
      choices.clear();
      jobAnswers.forEach((resolve) => resolve(null));
      jobAnswers.clear();
      takeovers.forEach((resolve) => resolve(false));
      takeovers.clear();
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
      jobAnswers.forEach((resolve) => resolve(null));
      jobAnswers.clear();
      takeovers.forEach((resolve) => resolve(false));
      takeovers.clear();
      input.close();
      currentTurn?.abort();
      await browser.close().catch(() => {});
    },
  };
}
