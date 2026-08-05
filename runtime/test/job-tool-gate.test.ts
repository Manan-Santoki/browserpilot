import { describe, expect, test } from "bun:test";
import { wrapMcpTools } from "../src/agent/engine/tools";

function deps(prepared: boolean, resolvePlaceholder?: (token: { kind: "PROFILE"; id: string }) => Promise<unknown>) {
  return {
    format: "anthropic" as const,
    vision: true,
    destructivePatterns: [],
    emit() {},
    requestApproval: async () => true,
    onImage: async () => {},
    completedDownload: () => undefined,
    collectImage() {},
    canSubmit: () => prepared,
    resolvePlaceholder: resolvePlaceholder as never,
  };
}

describe("job browser execution gate", () => {
  test("blocks final submit until the runtime inventory passes", async () => {
    let calls = 0;
    const tools = wrapMcpTools("playwright", { browser_click: { inputSchema: {}, execute: async () => { calls++; return { content: [{ type: "text", text: "clicked" }] }; } } }, deps(false));
    const output = await (tools.browser_click as any).execute({ element: "Submit application", ref: "e12" }, {});
    expect(output.text).toContain("blocked");
    expect(calls).toBe(0);
  });

  test("also blocks Enter-key and submit-flag bypasses before preparation", async () => {
    let calls = 0;
    const definitions = {
      browser_press_key: { inputSchema: {}, execute: async () => { calls++; return { content: [] }; } },
      browser_type: { inputSchema: {}, execute: async () => { calls++; return { content: [] }; } },
    };
    const tools = wrapMcpTools("playwright", definitions, deps(false));
    expect((await (tools.browser_press_key as any).execute({ key: "Enter" }, {})).text).toContain("blocked");
    expect((await (tools.browser_type as any).execute({ element: "Last field", text: "x", submit: true }, {})).text).toContain("blocked");
    expect(calls).toBe(0);
  });

  test("substitutes protected values only in the executable call", async () => {
    let received: unknown;
    const tools = wrapMcpTools("playwright", { browser_type: { inputSchema: {}, execute: async (input: unknown) => { received = input; return { content: [{ type: "text", text: "typed" }] }; } } }, deps(true, async () => "private@example.com"));
    await (tools.browser_type as any).execute({ element: "Email", text: "{{BP_PROFILE:email}}" }, {});
    expect(received).toEqual({ element: "Email", text: "private@example.com" });
  });

  test("redacts job form values from durable tool summaries", async () => {
    const summaries: string[] = [];
    const wrapped = wrapMcpTools("playwright", {
      browser_type: { inputSchema: {}, execute: async () => ({ content: [{ type: "text", text: "typed" }] }) },
    }, {
      ...deps(true, async () => "private@example.com"),
      emit(event) { if (event.type === "tool_activity") summaries.push(event.summary); },
    });
    await (wrapped.browser_type as any).execute({ element: "Email", text: "{{BP_PROFILE:email}}" }, {});
    expect(summaries.join(" ")).not.toContain("private@example.com");
    expect(summaries.join(" ")).toContain("[protected value]");
  });

  test("blocks raw model-invented form values and evaluate-based mutation", async () => {
    let calls = 0;
    const wrapped = wrapMcpTools("playwright", {
      browser_type: { inputSchema: {}, execute: async () => { calls++; return { content: [] }; } },
      browser_evaluate: { inputSchema: {}, execute: async () => { calls++; return { content: [] }; } },
    }, deps(true, async () => "private@example.com"));
    expect((await (wrapped.browser_type as any).execute({ element: "Location", text: "Phoenix" }, {})).text)
      .toContain("must come from");
    expect((await (wrapped.browser_evaluate as any).execute({ function: "(el) => { el.value = 'Phoenix'; el.dispatchEvent(new Event('input')); }" }, {})).text)
      .toContain("disabled");
    expect(calls).toBe(0);
  });

  test("redacts protected values from later browser snapshots", async () => {
    const wrapped = wrapMcpTools("playwright", {
      browser_type: { inputSchema: {}, execute: async () => ({ content: [{ type: "text", text: "typed private@example.com" }] }) },
      browser_snapshot: { inputSchema: {}, execute: async () => ({ content: [{ type: "text", text: "Email private@example.com Phone 6232020066" }] }) },
    }, deps(true, async (token) => token.id === "phone" ? "+1-623-202-0066" : "private@example.com"));
    const typed = await (wrapped.browser_type as any).execute({ element: "Email", text: "{{BP_PROFILE:email}}" }, {});
    expect(typed.text).not.toContain("private@example.com");
    await (wrapped.browser_type as any).execute({ element: "Phone", text: "{{BP_PROFILE:phone}}" }, {});
    const snapshot = await (wrapped.browser_snapshot as any).execute({}, {});
    expect(snapshot.text).not.toContain("private@example.com");
    expect(snapshot.text).not.toContain("6232020066");
    expect(snapshot.text).toContain("[protected value]");
  });
});
