import { describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod/v4";
import { startAiSdkAgent } from "../src/agent/engine/loop";
import type { BrowserTools } from "../src/agent/engine/mcp";
import type { RobotEvent } from "../src/session/events";
import type { AgentRunner, StartAgentOptions } from "../src/agent/runner";

const SITE = {
  id: "site-1",
  name: "Example ERP",
  baseUrl: "https://target.example.com",
  loginStrategy: "cookie_mint" as const,
  loggedOutPattern: null,
  cookieName: "target-session",
  secret: "sekret",
  systemPromptNotes: null,
  destructivePatterns: null,
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const finish = { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage };

/** A model that says one thing and stops. */
function speaks(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          finish,
        ],
      }),
    }),
  });
}

/**
 * A model that calls one tool, then reports.
 *
 * Two responses in sequence, because a tool call is not an ending: the SDK
 * calls the model again with the result, and a mock that repeated its tool call
 * forever would hang the test rather than fail it.
 */
function callsTool(name: string, input: Record<string, unknown>, then: string) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      if (call++ === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: name,
                input: JSON.stringify(input),
              },
              { ...finish, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: then },
            { type: "text-end", id: "t1" },
            finish,
          ],
        }),
      };
    },
  });
}

/** A model that calls one tool, then another, then reports. */
function callsToolTwice(
  first: { name: string; input: Record<string, unknown> },
  second: { name: string; input: Record<string, unknown> },
  then: string,
) {
  const calls = [first, second];
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const next = calls[step++];
      if (next) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: `call-${step}`,
                toolName: next.name,
                input: JSON.stringify(next.input),
              },
              { ...finish, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: then },
            { type: "text-end", id: "t1" },
            finish,
          ],
        }),
      };
    },
  });
}

/**
 * A model that takes a screenshot, then reports — recording every prompt it was
 * given, so a test can assert on what actually reached the wire.
 */
function screenshotsAndRecords() {
  const prompts: unknown[][] = [];
  let step = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(options.prompt as unknown[]);
      if (step++ === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "browser_take_screenshot",
                input: "{}",
              },
              { ...finish, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "A dashboard with a red badge." },
            { type: "text-end", id: "t1" },
            finish,
          ],
        }),
      };
    },
  });
  return { model, prompts };
}

/** Browser tools that record what they were called with and answer as told. */
function fakeBrowser(reply: (args: Record<string, unknown>) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let closed = 0;

  const define = (name: string) => ({
    description: name,
    inputSchema: z.object({}).loose(),
    execute: async (args: never) => {
      calls.push({ name, args: args as Record<string, unknown> });
      return reply(args as Record<string, unknown>);
    },
  });

  const tools: BrowserTools = {
    tools: {
      browser_take_screenshot: define("browser_take_screenshot"),
      browser_snapshot: define("browser_snapshot"),
      browser_click: define("browser_click"),
    },
    close: async () => {
      closed++;
    },
  };

  return { tools, calls, get closed() { return closed; } };
}

const text = (body: string) => ({ content: [{ type: "text", text: body }] });
const png = () => ({
  content: [
    { type: "text", text: "Screenshot of the dashboard" },
    { type: "image", data: "QUFB", mimeType: "image/png" },
  ],
});

type Harness = {
  events: RobotEvent[];
  saved: Array<{ filename: string; bytes: Uint8Array }>;
  waitFor: (predicate: (events: RobotEvent[]) => boolean) => Promise<void>;
};

function harness(): Harness & { opts: Omit<StartAgentOptions, "model"> } {
  const events: RobotEvent[] = [];
  const saved: Array<{ filename: string; bytes: Uint8Array }> = [];

  return {
    events,
    saved,
    async waitFor(predicate) {
      for (let i = 0; i < 400; i++) {
        if (predicate(events)) return;
        await Bun.sleep(5);
      }
      throw new Error(`condition never met. events: ${JSON.stringify(events, null, 2)}`);
    },
    opts: {
      cdpEndpoint: "http://127.0.0.1:1234",
      site: SITE,
      env: {},
      sessionId: "sess-1",
      saveFile: async (filename, bytes) => {
        saved.push({ filename, bytes });
      },
      onEvent: (event) => events.push(event),
    },
  };
}

const turnDone = (events: RobotEvent[]) => events.some((e) => e.type === "agent_turn_complete");

describe("the AI SDK engine", () => {
  test("a plain answer becomes deltas, one message, and a completed turn", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("ok"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      { model: speaks("There are 47 open orders."), connect: async () => browser.tools },
    );

    agent.send("how many orders?");
    await h.waitFor(turnDone);
    await agent.stop();

    expect(h.events.filter((e) => e.type === "agent_text_delta")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "agent_text")).toEqual([
      { type: "agent_text", text: "There are 47 open orders." },
    ]);
    expect(h.events.at(-1)).toEqual({ type: "agent_turn_complete", outcome: "completed" });
  });

  test("a tool call is announced and executed", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("- button 'New order' [ref=e1]"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool("browser_snapshot", {}, "The page has a New order button."),
        connect: async () => browser.tools,
      },
    );

    agent.send("what is on the page?");
    await h.waitFor(turnDone);
    await agent.stop();

    expect(browser.calls.map((c) => c.name)).toEqual(["browser_snapshot"]);
    expect(h.events).toContainEqual({
      type: "tool_activity",
      tool: "browser_snapshot",
      summary: "browser_snapshot",
    });
  });

  test("the screenshot filename is stripped before the call runs", async () => {
    // With one, Playwright MCP writes the file into its own output directory
    // and returns a path — so the picture reaches neither the person who asked
    // for it nor the model that took it.
    const h = harness();
    const browser = fakeBrowser(() => png());

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool(
          "browser_take_screenshot",
          { filename: "shot.png", fullPage: true },
          "Here it is.",
        ),
        connect: async () => browser.tools,
      },
    );

    agent.send("screenshot please");
    await h.waitFor(turnDone);
    await agent.stop();

    expect(browser.calls[0]!.args).toEqual({ fullPage: true });
  });

  test("an image a tool returned is saved and announced", async () => {
    const h = harness();
    const browser = fakeBrowser(() => png());

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool("browser_take_screenshot", {}, "Here it is."),
        connect: async () => browser.tools,
      },
    );

    agent.send("screenshot please");
    await h.waitFor((events) => events.some((e) => e.type === "screenshot"));
    await h.waitFor(turnDone);
    await agent.stop();

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.filename).toBe("screenshot-1.png");
    // Saved as bytes, not base64: the transcript would otherwise carry a few
    // hundred kilobytes per shot and replay it on every reload.
    expect(Buffer.from(h.saved[0]!.bytes).toString()).toBe("AAA");
    expect(h.events).toContainEqual({
      type: "screenshot",
      filename: "screenshot-1.png",
      url: "/api/sessions/sess-1/files/screenshot-1.png",
    });
  });

  test("a gated tool waits for the person and runs once approved", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("clicked"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool(
          "browser_click",
          { element: "Delete order button", ref: "e9" },
          "Deleted.",
        ),
        connect: async () => browser.tools,
      },
    );

    agent.send("delete order 42");
    await h.waitFor((events) => events.some((e) => e.type === "approval_request"));

    // Nothing has happened to the browser yet — that is the whole point of a gate.
    expect(browser.calls).toHaveLength(0);

    const request = h.events.find((e) => e.type === "approval_request")!;
    agent.approve(request.requestId, true);

    await h.waitFor(turnDone);
    await agent.stop();

    expect(browser.calls.map((c) => c.name)).toEqual(["browser_click"]);
    expect(h.events).toContainEqual({
      type: "approval_resolved",
      requestId: request.requestId,
      approved: true,
    });
  });

  test("a denied tool never reaches the browser", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("clicked"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool("browser_click", { element: "Delete order button" }, "Understood."),
        connect: async () => browser.tools,
      },
    );

    agent.send("delete order 42");
    await h.waitFor((events) => events.some((e) => e.type === "approval_request"));
    agent.approve(h.events.find((e) => e.type === "approval_request")!.requestId, false);

    await h.waitFor(turnDone);
    await agent.stop();

    expect(browser.calls).toHaveLength(0);
  });

  test("the choice tool shows a selector and returns what was picked", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("ok"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsTool(
          "ask_user_choice",
          {
            question: "Which warehouse?",
            options: [
              { label: "North", value: "wh-n" },
              { label: "South", value: "wh-s" },
            ],
          },
          "Using South.",
        ),
        connect: async () => browser.tools,
      },
    );

    agent.send("create a transfer");
    await h.waitFor((events) => events.some((e) => e.type === "choice_request"));

    const request = h.events.find((e) => e.type === "choice_request")!;
    expect(request.options).toHaveLength(2);
    agent.choose(request.requestId, "wh-s");

    await h.waitFor(turnDone);
    await agent.stop();

    expect(h.events).toContainEqual({
      type: "choice_resolved",
      requestId: request.requestId,
      value: "wh-s",
      label: "South",
    });
  });

  test("a browser call after a download has landed is refused, not performed", async () => {
    // Runtime-enforced rather than prompt-only: otherwise a model keeps
    // inspecting network logs and clicking the same button while the file is
    // already on screen. A *new* message from the person clears it, which is
    // why the download has to land mid-turn for this to be the real case.
    const h = harness();
    let agent: AgentRunner | undefined;
    const browser = fakeBrowser(() => {
      agent?.downloadDetected("orders.pdf");
      return text("- link 'orders.pdf'");
    });

    agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      {
        model: callsToolTwice(
          { name: "browser_snapshot", input: {} },
          { name: "browser_click", input: { element: "Download again" } },
          "The file is already downloaded.",
        ),
        connect: async () => browser.tools,
      },
    );

    agent.send("download the orders");
    await h.waitFor(turnDone);
    await agent.stop();

    // The first call ran and produced the download; the second was refused.
    expect(browser.calls.map((c) => c.name)).toEqual(["browser_snapshot"]);
  });

  test("stopping closes the browser tools", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("ok"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      { model: speaks("hi"), connect: async () => browser.tools },
    );

    await agent.stop();
    expect(browser.closed).toBe(1);
  });

  test("a voice task id rides on every event of its turn", async () => {
    const h = harness();
    const browser = fakeBrowser(() => text("ok"));

    const agent = await startAiSdkAgent(
      { ...h.opts, model: "test-model" },
      { model: speaks("Done."), connect: async () => browser.tools },
    );

    agent.send("read the total", "gemini_call_1");
    await h.waitFor(turnDone);
    await agent.stop();

    expect(h.events.every((e) => e.voiceTaskId === "gemini_call_1")).toBe(true);
  });

  describe("a screenshot reaching the model", () => {
    /** Run one screenshot turn and hand back what the second model call saw. */
    async function screenshotTurn(opts: { format: "anthropic" | "openai"; vision: boolean }) {
      const h = harness();
      const browser = fakeBrowser(() => png());
      const recorder = screenshotsAndRecords();

      const agent = await startAiSdkAgent(
        { ...h.opts, model: "test-model", ...opts },
        { model: recorder.model, connect: async () => browser.tools },
      );

      agent.send("show me the dashboard");
      await h.waitFor(turnDone);
      await agent.stop();

      // The prompt for the follow-up call: what the model was given to answer from.
      const seen = recorder.prompts[1] ?? [];
      return { seen, json: JSON.stringify(seen), h };
    }

    test("Anthropic carries it inside the tool result", async () => {
      const { seen, json } = await screenshotTurn({ format: "anthropic", vision: true });

      expect(json).toContain("QUFB");
      // Attached to the call that produced it, so there is nothing extra to
      // explain the relationship.
      const toolMessage = (seen as Array<{ role: string }>).find((m) => m.role === "tool");
      expect(JSON.stringify(toolMessage)).toContain("QUFB");
      expect(json).not.toContain("follows in the next message");
    });

    test("OpenAI gets a note in the tool result and the image just after it", async () => {
      // This is the whole reason the loop is ours: an OpenAI `tool` message is
      // text only, so a bridge that left the image there dropped it silently
      // and the model described a page it never saw.
      const { seen, json } = await screenshotTurn({ format: "openai", vision: true });

      const roles = (seen as Array<{ role: string }>).map((m) => m.role);
      const toolMessage = (seen as Array<{ role: string }>).find((m) => m.role === "tool");

      expect(JSON.stringify(toolMessage)).not.toContain("QUFB");
      expect(JSON.stringify(toolMessage)).toContain("follows in the next message");
      // The image arrives as a user message immediately after the tool result.
      expect(roles.at(-1)).toBe("user");
      expect(JSON.stringify(seen.at(-1))).toContain("QUFB");
      expect(json).toContain("browser_take_screenshot");
    });

    test("a blind model is sent no image at all, in either format", async () => {
      for (const format of ["anthropic", "openai"] as const) {
        const { json } = await screenshotTurn({ format, vision: false });
        expect(json).not.toContain("QUFB");
        expect(json).toContain("cannot read images");
      }
    });

    test("the picture still reaches the person even when the model cannot see it", async () => {
      const { h } = await screenshotTurn({ format: "openai", vision: false });
      expect(h.saved).toHaveLength(1);
      expect(h.events.some((e) => e.type === "screenshot")).toBe(true);
    });
  });

  describe("interrupting", () => {
    /**
     * A model that streams slowly and stops when the request is aborted.
     *
     * Honouring the signal is what a real provider does — it is the HTTP
     * request being cancelled. `simulateReadableStream` ignores it, so a mock
     * built on that alone would test the mock rather than the engine.
     */
    function slowModel() {
      return new MockLanguageModelV4({
        doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              for (let i = 0; i < 40; i++) {
                if (abortSignal?.aborted) {
                  controller.error(new DOMException("Aborted", "AbortError"));
                  return;
                }
                controller.enqueue({ type: "text-delta", id: "t1", delta: `part ${i} ` });
                await Bun.sleep(30);
              }
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue(finish);
              controller.close();
            },
          }),
        }),
      });
    }

    test("stops the turn and leaves the session able to take another", async () => {
      // The contract is not "the turn dies" but "the turn dies and the session
      // does not" — an interrupt that also killed the conversation would make
      // the Stop button a session-ending button.
      const h = harness();
      const browser = fakeBrowser(() => text("ok"));

      const agent = await startAiSdkAgent(
        { ...h.opts, model: "test-model" },
        { model: slowModel(), connect: async () => browser.tools },
      );

      agent.send("count slowly");
      await h.waitFor((events) => events.some((e) => e.type === "agent_text_delta"));
      await agent.interrupt();

      await h.waitFor(turnDone);
      const outcome = h.events.find((e) => e.type === "agent_turn_complete");
      expect(outcome).toMatchObject({ outcome: "interrupted" });

      // And the loop is still there to serve the next message.
      h.events.length = 0;
      agent.send("are you still there?");
      await h.waitFor(turnDone);
      expect(h.events.some((e) => e.type === "agent_turn_complete")).toBe(true);

      await agent.stop();
    });

    test("a pending approval is declined rather than left hanging", async () => {
      // Otherwise the tool's execute() never settles and the turn cannot end.
      const h = harness();
      const browser = fakeBrowser(() => text("clicked"));

      const agent = await startAiSdkAgent(
        { ...h.opts, model: "test-model" },
        {
          model: callsTool("browser_click", { element: "Delete order" }, "Done."),
          connect: async () => browser.tools,
        },
      );

      agent.send("delete order 42");
      await h.waitFor((events) => events.some((e) => e.type === "approval_request"));
      await agent.interrupt();

      await h.waitFor(turnDone);
      expect(browser.calls).toHaveLength(0);
      await agent.stop();
    });
  });
});
