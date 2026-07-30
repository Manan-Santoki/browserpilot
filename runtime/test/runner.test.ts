import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt } from "../src/agent/prompt";
import { startAgent, type QueryFn } from "../src/agent/runner";
import type { RobotEvent } from "../src/session/events";

/**
 * The SDK hands its permission callback more context than we use. Tests only
 * care about the signal, so fill the rest in one place.
 */
const permissionOptions = () =>
  ({
    signal: new AbortController().signal,
    toolUseID: "tu_test",
    requestId: "req_test",
  }) as unknown as Parameters<CanUseTool>[2];

const SITE = {
  id: "site-1",
  name: "Example ERP",
  baseUrl: "https://target.example.com",
  loginStrategy: "cookie_mint" as const,
  loggedOutPattern: null,
  cookieName: "target-session",
  secret: "sekret",
  systemPromptNotes: "Purchase orders live at /purchase-orders.",
  destructivePatterns: null,
};

const OPTS = {
  cdpEndpoint: "http://127.0.0.1:1234",
  site: SITE,
  model: "claude-opus-5",
  env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
  sessionId: "sess-1",
  // Overridden by the tests that actually write a screenshot.
  saveFile: async () => {},
};

/** Captures what the runner passed to the SDK and lets the test drive messages back. */
function fakeQuery() {
  let captured: Parameters<QueryFn>[0] | undefined;
  const emit: Array<() => void> = [];
  const queue: unknown[] = [];
  let done = false;

  const queryFn: QueryFn = (params) => {
    captured = params;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift() as never;
            continue;
          }
          if (done) return;
          await new Promise<void>((r) => emit.push(() => r()));
        }
      },
      async interrupt() {},
      close() {
        done = true;
        emit.splice(0).forEach((fn) => fn());
      },
    } as unknown as ReturnType<QueryFn>;
  };

  return {
    queryFn,
    get captured() {
      return captured!;
    },
    push(message: unknown) {
      queue.push(message);
      emit.splice(0).forEach((fn) => fn());
    },
    finish() {
      done = true;
      emit.splice(0).forEach((fn) => fn());
    },
  };
}

const assistantText = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const assistantToolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "tu_1", name, input }] },
});

describe("buildSystemPrompt", () => {
  test("names the target app and forbids leaving it", () => {
    const prompt = buildSystemPrompt(SITE);
    expect(prompt).toContain("https://target.example.com");
    expect(prompt).toContain("Example ERP");
    expect(prompt.toLowerCase()).toContain("do not navigate");
  });

  test("includes the site's own notes when it has them", () => {
    expect(buildSystemPrompt(SITE)).toContain("Purchase orders live at /purchase-orders.");
  });

  test("uses structured choices and stops after a successful download", () => {
    const prompt = buildSystemPrompt(SITE);
    expect(prompt).toContain("ask_user_choice");
    expect(prompt).toContain("exact option labels and values");
    expect(prompt).toContain("Do not reopen or screenshot a downloaded PDF");
    expect(prompt).toContain("merely to reconfirm a successful download");
  });

  test("omits the notes section entirely when there are none", () => {
    const prompt = buildSystemPrompt({ ...SITE, systemPromptNotes: null });
    expect(prompt).not.toContain("About this application");
  });

  test("no target is hardcoded — the prompt follows the profile", () => {
    const prompt = buildSystemPrompt({ ...SITE, name: "Other App", baseUrl: "https://other.test" });
    expect(prompt).toContain("https://other.test");
    expect(prompt).not.toContain("target.example.com");
  });
});

describe("startAgent", () => {
  test("wires Playwright plus the BrowserPilot choice tool, and no host tools", async () => {
    const fake = fakeQuery();
    const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });

    const mcp = fake.captured.options!.mcpServers as Record<
      string,
      { command?: string; args?: string[]; type?: string }
    >;
    expect(mcp.playwright!.args).toContain("--cdp-endpoint");
    expect(mcp.playwright!.args).toContain(OPTS.cdpEndpoint);
    // Must run under node: playwright's connectOverCDP hangs under Bun, which
    // makes MCP silently fall back to its own browser with no session cookie.
    expect(mcp.playwright!.command).toBe("node");
    // Resolved from our own node_modules — never npx, which on some machines
    // resolves to a different platform's binary and needs a network fetch.
    expect(mcp.playwright!.args![0]).toMatch(/@playwright[/\\]mcp[/\\]cli\.js$/);
    expect(mcp.playwright!.args).not.toContain("-y");
    expect(mcp.browserpilot!.type).toBe("sdk");
    expect(fake.captured.options!.strictMcpConfig).toBe(true);
    // No built-in Claude Code tools: the browser is the agent's whole world.
    expect(fake.captured.options!.tools).toEqual([]);
    expect(fake.captured.options!.model).toBe("claude-opus-5");
    await runner.stop();
  });

  test("passes our credential and keeps the inherited PATH", async () => {
    // The SDK *replaces* the subprocess environment rather than merging, so a
    // bare credential object would leave the agent with no PATH and no HOME —
    // and `node` would stop resolving for the MCP server.
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-ambient";
    try {
      const fake = fakeQuery();
      const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });
      const env = fake.captured.options!.env as Record<string, string>;

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
      expect(typeof env.PATH).toBe("string");
      // An ambient key must never quietly outrank the configured credential.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();

      await runner.stop();
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  test("emits assistant text as agent_text events", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    fake.push(assistantText("Opening Purchase Orders"));
    await Bun.sleep(20);

    expect(events).toContainEqual({ type: "agent_text", text: "Opening Purchase Orders" });
    await runner.stop();
  });

  test("emits tool_activity for tool_use blocks", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    fake.push(assistantToolUse("mcp__playwright__browser_click", { element: "New PO button" }));
    await Bun.sleep(20);

    const activity = events.find((e) => e.type === "tool_activity");
    expect(activity).toBeDefined();
    expect(activity).toMatchObject({ type: "tool_activity", tool: "browser_click" });
    await runner.stop();
  });

  test("auto-classified tools are allowed without asking", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    const canUseTool = fake.captured.options!.canUseTool!;
    const result = await canUseTool(
      "mcp__playwright__browser_click",
      { element: "Save" },
      permissionOptions(),
    );

    expect(result?.behavior).toBe("allow");
    expect(events.some((e) => e.type === "approval_request")).toBe(false);
    await runner.stop();
  });

  test("destructive tools emit approval_request and block until approved", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    const canUseTool = fake.captured.options!.canUseTool!;
    const pending = canUseTool(
      "mcp__playwright__browser_click",
      { element: "Delete purchase order" },
      permissionOptions(),
    );

    await Bun.sleep(20);
    const request = events.find((e) => e.type === "approval_request");
    expect(request).toBeDefined();
    if (request?.type !== "approval_request") throw new Error("unreachable");

    runner.approve(request.requestId, true);
    expect((await pending)?.behavior).toBe("allow");
    expect(events).toContainEqual({
      type: "approval_resolved",
      requestId: request.requestId,
      approved: true,
    });
    await runner.stop();
  });

  test("a denied approval returns deny with a message", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    const canUseTool = fake.captured.options!.canUseTool!;
    const pending = canUseTool(
      "mcp__playwright__browser_click",
      { element: "Cancel order" },
      permissionOptions(),
    );
    await Bun.sleep(20);
    const request = events.find((e) => e.type === "approval_request");
    if (request?.type !== "approval_request") throw new Error("unreachable");

    runner.approve(request.requestId, false);
    const result = await pending;
    if (result === null || result.behavior !== "deny") {
      throw new Error(`expected a denial, got ${JSON.stringify(result)}`);
    }
    expect(result.message).toMatch(/declined/i);
    await runner.stop();
  });

  test("send() forwards the user's text to the SDK input stream", async () => {
    const fake = fakeQuery();
    const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });

    runner.send("create a PO for KEI");
    const iterator = (fake.captured.prompt as AsyncIterable<{ message: { content: string } }>)[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();

    expect(first.value!.message.content).toBe("create a PO for KEI");
    await runner.stop();
  });
});

describe("screenshots", () => {
  /** A tool result carrying an image, the way MCP returns one. */
  const toolResultImage = (data: string, mediaType = "image/png") => ({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }],
        },
      ],
    },
  });

  // A one-pixel PNG, so the bytes on disk can be compared exactly.
  const PIXEL =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("a screenshot tool result is kept and announced with a URL", async () => {
    const kept: Array<{ filename: string; bytes: Uint8Array }> = [];
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      {
        ...OPTS,
        sessionId: "sess-42",
        saveFile: async (filename, bytes) => {
          kept.push({ filename, bytes });
        },
        onEvent: (e) => events.push(e),
      },
      { queryFn: fake.queryFn },
    );

    fake.push(toolResultImage(PIXEL));
    await Bun.sleep(50);

    const shot = events.find((e) => e.type === "screenshot");
    if (shot?.type !== "screenshot") throw new Error("no screenshot event");
    expect(shot.filename).toBe("screenshot-1.png");
    expect(shot.url).toBe("/api/sessions/sess-42/files/screenshot-1.png");

    // The URL is a promise to serve these bytes, so they must have been handed
    // over — writing them to a directory of its own is what broke them once
    // downloads moved into object storage.
    expect(kept).toHaveLength(1);
    expect(kept[0]!.filename).toBe("screenshot-1.png");
    expect(Buffer.from(kept[0]!.bytes)).toEqual(Buffer.from(PIXEL, "base64"));

    await runner.stop();
  });

  test("each screenshot gets its own name, and the type decides the extension", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    fake.push(toolResultImage(PIXEL));
    fake.push(toolResultImage(PIXEL, "image/jpeg"));
    await Bun.sleep(50);

    const names = events.filter((e) => e.type === "screenshot").map((e) => e.filename);
    expect(names).toEqual(["screenshot-1.png", "screenshot-2.jpg"]);

    await runner.stop();
  });

  test("a tool result with no image produces no screenshot", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    fake.push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ok" }] }],
      },
    });
    await Bun.sleep(30);

    expect(events.some((e) => e.type === "screenshot")).toBe(false);
    await runner.stop();
  });

  test("the filename argument is stripped so MCP returns the image itself", async () => {
    // With a filename, Playwright MCP writes the file into its own output
    // directory and hands back a path — the picture reaches neither the user
    // nor the model, which then describes the page from an older snapshot.
    const fake = fakeQuery();
    const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });

    const canUseTool = fake.captured.options!.canUseTool!;
    const result = await canUseTool(
      "mcp__playwright__browser_take_screenshot",
      { type: "png", scale: "css", filename: "dashboard.png" },
      permissionOptions(),
    );

    if (result?.behavior !== "allow") throw new Error("screenshots must not need approval");
    expect(result.updatedInput).toEqual({ type: "png", scale: "css" });
    await runner.stop();
  });

  test("other tools keep every argument they were given", async () => {
    const fake = fakeQuery();
    const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });

    const canUseTool = fake.captured.options!.canUseTool!;
    const input = { element: "Save", filename: "not-a-screenshot.png" };
    const result = await canUseTool("mcp__playwright__browser_click", input, permissionOptions());

    if (result?.behavior !== "allow") throw new Error("expected a plain click to be allowed");
    expect(result.updatedInput).toEqual(input);
    await runner.stop();
  });
});

describe("approval summaries", () => {
  test("evaluate runs unblocked, but its code is shown in the activity feed", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    // It no longer asks for approval...
    const canUseTool = fake.captured.options!.canUseTool!;
    const decision = await canUseTool(
      "mcp__playwright__browser_evaluate",
      { function: "() => document.documentElement.className" },
      permissionOptions(),
    );
    expect(decision?.behavior).toBe("allow");
    expect(events.some((e) => e.type === "approval_request")).toBe(false);

    // ...but the user can still see exactly what ran.
    fake.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "mcp__playwright__browser_evaluate",
            input: { function: "() => document.documentElement.className" },
          },
        ],
      },
    });
    await Bun.sleep(20);

    const activity = events.find((e) => e.type === "tool_activity");
    if (activity?.type !== "tool_activity") throw new Error("no activity reported");
    expect(activity.summary).toContain("document.documentElement.className");

    await runner.stop();
  });

  test("long code is truncated rather than flooding the feed", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    fake.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "mcp__playwright__browser_evaluate",
            input: { function: `() => { ${"const x = 1; ".repeat(60)} }` },
          },
        ],
      },
    });
    await Bun.sleep(20);

    const activity = events.find((e) => e.type === "tool_activity");
    if (activity?.type !== "tool_activity") throw new Error("no activity reported");
    expect(activity.summary.length).toBeLessThan(200);
    expect(activity.summary).toEndWith("…");

    await runner.stop();
  });

  test("a click still names the element it targets", async () => {
    const fake = fakeQuery();
    const events: RobotEvent[] = [];
    const runner = await startAgent(
      { ...OPTS, onEvent: (e) => events.push(e) },
      { queryFn: fake.queryFn },
    );

    const canUseTool = fake.captured.options!.canUseTool!;
    void canUseTool(
      "mcp__playwright__browser_click",
      { element: "Delete purchase order" },
      permissionOptions(),
    );
    await Bun.sleep(20);

    const request = events.find((e) => e.type === "approval_request");
    if (request?.type !== "approval_request") throw new Error("no approval requested");
    expect(request.summary).toContain("Delete purchase order");

    runner.approve(request.requestId, false);
    await runner.stop();
  });
});
