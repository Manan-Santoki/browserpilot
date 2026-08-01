import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { compact, estimateTokens, DEFAULT_COMPACTION } from "../src/agent/engine/compaction";

/** A tool result the size of a real accessibility snapshot. */
const snapshot = (id: string, size = 40_000): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "browser_snapshot",
      output: { type: "text", value: `page ${id} `.padEnd(size, "x") },
    },
  ],
});

const said = (text: string): ModelMessage => ({ role: "user", content: text });

// A threshold in the hundreds of tokens rather than the hundreds of thousands,
// so a readable fixture is enough to cross it.
const options = {
  ...DEFAULT_COMPACTION,
  threshold: 1_000,
  keepRecentToolResults: 2,
  summaryLength: 100,
};

describe("compact", () => {
  test("leaves a short transcript exactly as it was", () => {
    const messages = [said("hello"), snapshot("a", 100)];
    expect(compact(messages, options)).toBe(messages);
  });

  test("trims the old snapshots and keeps the recent ones whole", () => {
    const messages = [said("find the orders"), snapshot("a"), snapshot("b"), snapshot("c")];
    const compacted = compact(messages, options);

    const rendered = compacted.map((m) => JSON.stringify(m).length);
    // The first is trimmed; the last two are the ones the current step is
    // reasoning about, so they survive.
    expect(rendered[1]).toBeLessThan(1_000);
    expect(rendered[2]).toBeGreaterThan(10_000);
    expect(rendered[3]).toBeGreaterThan(10_000);
  });

  test("never drops a word anyone actually said", () => {
    // The bulk is all machine output. A person's instruction is both tiny and
    // the only thing that says what the session is for.
    const messages = [said("find the orders"), snapshot("a"), snapshot("b"), snapshot("c")];
    expect(compact(messages, options)[0]).toEqual(said("find the orders"));
  });

  test("a trimmed result stays a tool result", () => {
    // Removing it would orphan the assistant tool call above it, and providers
    // reject a conversation with a call and no answer.
    const compacted = compact([snapshot("a"), snapshot("b"), snapshot("c")], options);
    expect(compacted[0]!.role).toBe("tool");
    const part = (compacted[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(part.type).toBe("tool-result");
    expect(part.toolCallId).toBe("a");
    expect(JSON.stringify(part.output)).toContain("trimmed");
  });

  test("an error result is left alone however old", () => {
    // It is already short, and it is the thing the agent most needs to re-read.
    const failed: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "e",
          toolName: "browser_click",
          output: { type: "error-text", value: "element not found" },
        },
      ],
    };
    const compacted = compact([failed, snapshot("b"), snapshot("c")], options);
    expect(compacted[0]).toEqual(failed);
  });
});

describe("estimateTokens", () => {
  test("scales with the transcript", () => {
    expect(estimateTokens([said("hi")])).toBeLessThan(estimateTokens([snapshot("a")]));
  });
});
