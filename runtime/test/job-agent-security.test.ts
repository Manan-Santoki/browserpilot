import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod/v4";
import { startAiSdkAgent } from "../src/agent/engine/loop";
import type { JobAgentHandlers, StartAgentOptions } from "../src/agent/runner";
import type { RobotEvent } from "../src/session/events";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage };

function scripted(calls: Array<{ name: string; input: Record<string, unknown> }>) {
  const prompts: string[] = [];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(JSON.stringify(options.prompt));
      const next = calls[step++];
      if (next) return {
        stream: simulateReadableStream({ chunks: [
          { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: next.name, input: JSON.stringify(next.input) },
          { ...finish, finishReason: { unified: "tool-calls" as const, raw: undefined } },
        ] }),
      };
      return { stream: simulateReadableStream({ chunks: [
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: "done" },
        { type: "text-end" as const, id: "t1" },
        finish,
      ] }) };
    },
  });
  return { model, prompts };
}

function baseJob(overrides: Partial<JobAgentHandlers> = {}): JobAgentHandlers {
  return {
    applicationId: "11111111-1111-4111-8111-111111111111",
    systemPrompt: "job",
    lookupCandidate: async () => ({}),
    lookupSavedAnswer: async () => null,
    getPortalAccount: async () => ({ username: "{{BP_SECRET:portal_username}}", password: "{{BP_SECRET:portal_password}}" }),
    confirmPortalAccount: async () => {},
    resetPortalAccount: async () => ({ username: "{{BP_SECRET:portal_username}}", password: "{{BP_SECRET:portal_password}}" }),
    waitForGmailVerification: async () => ({}),
    saveAnswer: async () => "{{BP_ANSWER:answer_1}}",
    getApplicationSchema: async () => ({ available: false }),
    getApplicationDocuments: async () => ({ resume: "{{BP_DOCUMENT:resume}}" }),
    getCoverLetterContext: async () => ({ profile: {}, resumeText: "resume" }),
    generateCoverLetter: async () => "{{BP_DOCUMENT:cover_letter}}",
    discoverJob: async () => ({}),
    prepareSubmission: async () => ({ ok: true }),
    recordSubmission: async () => ({ ok: true }),
    recordFailure: async () => {},
    recordAttention: async () => {},
    resolvePlaceholder: async (placeholder) => {
      if (placeholder.id === "portal_username") return "candidate@example.test";
      if (placeholder.id === "portal_password") return "NeverModelPlaintext!42";
      if (placeholder.id === "answer_1") return "175000";
      if (placeholder.id === "resume") return "/private/resume.pdf";
      throw new Error("unknown placeholder");
    },
    ...overrides,
  };
}

async function run(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  job: JobAgentHandlers,
  answer?: string | number,
  completeTakeover = false,
) {
  const events: RobotEvent[] = [];
  const browserCalls: Record<string, unknown>[] = [];
  const scriptedModel = scripted(calls);
  const opts: StartAgentOptions = {
    cdpEndpoint: "http://127.0.0.1:1",
    site: { id: "job", name: "Job", baseUrl: "https://jobs.example.com", loginStrategy: "manual_login", cookieName: "session", loggedOutPattern: null, secret: null, systemPromptNotes: null, destructivePatterns: [] },
    model: "test",
    env: {},
    sessionId: "session",
    saveFile: async () => {},
    onEvent: (event) => events.push(event),
    job,
  };
  const agent = await startAiSdkAgent(opts, {
    model: scriptedModel.model,
    connect: async () => ({
      tools: {
        browser_type: {
          description: "type",
          inputSchema: z.object({ element: z.string(), text: z.unknown() }),
          execute: async (input: never) => { browserCalls.push(input); return { content: [{ type: "text", text: "typed" }] }; },
        },
        browser_file_upload: {
          description: "upload",
          inputSchema: z.object({ paths: z.array(z.string()) }),
          execute: async (input: never) => { browserCalls.push(input); return { content: [{ type: "text", text: "uploaded" }] }; },
        },
      },
      close: async () => {},
    }),
  });
  agent.send("apply");
  if (answer) {
    for (let index = 0; index < 200 && !events.some((event) => event.type === "job_question"); index++) await Bun.sleep(5);
    const question = events.find((event) => event.type === "job_question");
    if (!question || question.type !== "job_question") throw new Error("question did not arrive");
    agent.answerJobQuestion?.(question.requestId, answer);
  }
  if (completeTakeover) {
    for (let index = 0; index < 200 && !events.some((event) => event.type === "manual_takeover" && event.active); index++) await Bun.sleep(5);
    const takeover = events.find((event) => event.type === "manual_takeover" && event.active);
    if (!takeover || takeover.type !== "manual_takeover") throw new Error("manual takeover did not arrive");
    agent.resolveTakeover?.(takeover.requestId, true);
  }
  for (let index = 0; index < 400 && !events.some((event) => event.type === "agent_turn_complete"); index++) await Bun.sleep(5);
  await agent.stop();
  return { events, browserCalls, prompts: scriptedModel.prompts };
}

describe("job agent secret boundaries", () => {
  test("portal passwords are substituted only inside browser execution", async () => {
    const result = await run([
      { name: "get_portal_account", input: {} },
      { name: "browser_type", input: { element: "Password", text: "{{BP_SECRET:portal_password}}" } },
    ], baseJob());
    expect(result.browserCalls[0]).toMatchObject({ text: "NeverModelPlaintext!42" });
    expect(result.prompts.join(" ")).not.toContain("NeverModelPlaintext!42");
    expect(result.events.filter((event) => event.type === "tool_activity").map((event) => JSON.stringify(event)).join(" "))
      .not.toContain("NeverModelPlaintext!42");
  });

  test("a newly collected answer returns an opaque placeholder, not plaintext model context", async () => {
    let saved: unknown;
    const result = await run([
      { name: "request_unseen_answer", input: { question: "Desired salary", answerType: "number", options: [] } },
      { name: "browser_type", input: { element: "Salary", text: "{{BP_ANSWER:answer_1}}" } },
    ], baseJob({ saveAnswer: async (_question, value) => { saved = value; return "{{BP_ANSWER:answer_1}}"; } }), 175000);
    expect(saved).toBe(175000);
    expect(result.browserCalls[0]).toMatchObject({ text: "175000" });
    expect(result.prompts.join(" ")).not.toContain("175000");
  });

  test("requesting an already saved exact answer never pauses the application", async () => {
    let saveCalls = 0;
    const result = await run([
      { name: "request_unseen_answer", input: { question: "Sponsorship?", answerType: "single_choice", options: ["Yes", "No"] } },
    ], baseJob({
      lookupSavedAnswer: async () => "{{BP_ANSWER:answer_1}}",
      saveAnswer: async () => { saveCalls++; return "{{BP_ANSWER:answer_1}}"; },
    }));
    expect(saveCalls).toBe(0);
    expect(result.events.some((event) => event.type === "job_question")).toBe(false);
    expect(result.prompts.join(" ")).toContain("existing_exact_answer");
  });

  test("completed manual takeover clears the legal-review flag for server preparation", async () => {
    let receivedInventory: Parameters<JobAgentHandlers["prepareSubmission"]>[0] | undefined;
    let receivedContext: Parameters<JobAgentHandlers["prepareSubmission"]>[1] | undefined;
    await run([
      { name: "request_manual_takeover", input: { reason: "Review the legal declaration" } },
      { name: "prepare_application_submission", input: {
        requiredFields: [{ key: "legal", handled: true }],
        unresolvedQuestionIds: [],
        resumeStaged: true,
        coverLetterRequired: false,
        coverLetterStaged: true,
        consentGranted: true,
        unusualLegalLanguage: true,
      } },
    ], baseJob({
      prepareSubmission: async (inventory, context) => {
        receivedInventory = inventory;
        receivedContext = context;
        return { ok: true };
      },
    }), undefined, true);
    expect(receivedInventory?.unusualLegalLanguage).toBe(false);
    expect(receivedContext).toEqual({ manualTakeoverCompleted: true });
  });

  test("decrypted résumé paths exist only inside the browser upload call", async () => {
    const result = await run([
      { name: "get_application_documents", input: {} },
      { name: "browser_file_upload", input: { paths: ["{{BP_DOCUMENT:resume}}"] } },
    ], baseJob());
    expect(result.browserCalls[0]).toEqual({ paths: ["/private/resume.pdf"] });
    expect(result.prompts.join(" ")).not.toContain("/private/resume.pdf");
  });

  test("the model can request a deterministic ATS schema with a constrained board token", async () => {
    let requested: { boardToken?: string } | undefined;
    await run([
      { name: "get_application_schema", input: { boardToken: "asm" } },
    ], baseJob({
      getApplicationSchema: async (input) => {
        requested = input;
        return { available: true, provider: "greenhouse", questions: [] };
      },
    }));
    expect(requested).toEqual({ boardToken: "asm" });
  });

  test("CAPTCHA cannot be recorded as a terminal application failure", async () => {
    let failed = false;
    let attention = false;
    const result = await run([
      { name: "record_application_failure", input: { reason: "A reCAPTCHA requires completion" } },
    ], baseJob({
      recordFailure: async () => { failed = true; },
      recordAttention: async () => { attention = true; },
    }));
    expect(failed).toBe(false);
    expect(attention).toBe(false);
    expect(result.events.some((event) => event.type === "application_status" && event.status === "failed")).toBe(false);
  });

  test("missing candidate configuration pauses for attention instead of failing", async () => {
    let failed = false;
    let attentionReason = "";
    const result = await run([
      { name: "record_application_failure", input: { reason: "Candidate profile is not configured" } },
    ], baseJob({
      recordFailure: async () => { failed = true; },
      recordAttention: async (reason) => { attentionReason = reason; },
    }));
    expect(failed).toBe(false);
    expect(attentionReason).toContain("not configured");
    expect(result.events.some((event) => event.type === "application_status" && event.status === "needs_attention")).toBe(true);
  });
});
