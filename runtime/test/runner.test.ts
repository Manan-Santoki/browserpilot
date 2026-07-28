import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent/prompt";
import { startAgent, type QueryFn } from "../src/agent/runner";
import type { RobotEvent } from "../src/session/events";

const OPTS = {
  cdpEndpoint: "http://127.0.0.1:1234",
  jwmUrl: "https://jwm.example.com",
  model: "claude-opus-5",
  env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
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
    const prompt = buildSystemPrompt("https://jwm.example.com");
    expect(prompt).toContain("https://jwm.example.com");
    expect(prompt.toLowerCase()).toContain("do not navigate");
  });
});

describe("startAgent", () => {
  test("wires Playwright MCP to the session's CDP endpoint and nothing else", async () => {
    const fake = fakeQuery();
    const runner = await startAgent({ ...OPTS, onEvent: () => {} }, { queryFn: fake.queryFn });

    const mcp = fake.captured.options!.mcpServers as Record<string, { args: string[] }>;
    expect(mcp.playwright!.args).toContain("--cdp-endpoint");
    expect(mcp.playwright!.args).toContain(OPTS.cdpEndpoint);
    expect(fake.captured.options!.strictMcpConfig).toBe(true);
    expect(fake.captured.options!.model).toBe("claude-opus-5");
    expect(fake.captured.options!.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t" });

    await runner.stop();
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
      { signal: new AbortController().signal },
    );

    expect(result.behavior).toBe("allow");
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
      { signal: new AbortController().signal },
    );

    await Bun.sleep(20);
    const request = events.find((e) => e.type === "approval_request");
    expect(request).toBeDefined();
    if (request?.type !== "approval_request") throw new Error("unreachable");

    runner.approve(request.requestId, true);
    expect((await pending).behavior).toBe("allow");
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
      { signal: new AbortController().signal },
    );
    await Bun.sleep(20);
    const request = events.find((e) => e.type === "approval_request");
    if (request?.type !== "approval_request") throw new Error("unreachable");

    runner.approve(request.requestId, false);
    const result = await pending;
    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("unreachable");
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
