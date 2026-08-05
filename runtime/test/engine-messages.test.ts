import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  blindNote,
  hoistImages,
  imagePlaceholder,
  needsImageHoist,
  toolOutputContent,
  type ToolOutcome,
} from "../src/agent/engine/messages";

const shot: ToolOutcome = {
  text: "Took a screenshot of the dashboard.",
  image: { toolName: "browser_take_screenshot", mediaType: "image/png", data: "AAAA" },
};

describe("toolOutputContent", () => {
  test("Anthropic gets the image inside the tool result", () => {
    // Its Messages API can carry one, so the picture stays attached to the call
    // that produced it — which is the association the model reasons from.
    const parts = toolOutputContent(shot, "anthropic", true);
    expect(parts).toEqual([
      { type: "text", text: shot.text },
      { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
    ]);
  });

  test("OpenAI gets a note where the image cannot go", () => {
    // A `tool` message is text and nothing else. Putting an image there is how
    // every naive bridge silently drops screenshots.
    const parts = toolOutputContent(shot, "openai", true);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "text",
      text: `${shot.text}\n${imagePlaceholder("browser_take_screenshot")}`,
    });
  });

  test("a blind model is told what happened rather than sent a picture", () => {
    // qwen3.7-plus answers 400 to an image and the whole turn dies; saying so
    // keeps it working from the accessibility tree.
    for (const format of ["anthropic", "openai"] as const) {
      const parts = toolOutputContent(shot, format, false);
      expect(parts).toHaveLength(1);
      expect(JSON.stringify(parts)).not.toContain("AAAA");
      expect(parts[0]).toEqual({
        type: "text",
        text: `${shot.text}\n${blindNote("browser_take_screenshot")}`,
      });
    }
  });

  test("a result with no image is just its text", () => {
    expect(toolOutputContent({ text: "clicked" }, "openai", true)).toEqual([
      { type: "text", text: "clicked" },
    ]);
  });
});

describe("hoistImages", () => {
  const base: ModelMessage[] = [{ role: "user", content: "show me the dashboard" }];

  test("appends the picture as a user message that names its source", () => {
    const messages = hoistImages(base, [
      { toolName: "browser_take_screenshot", mediaType: "image/png", data: "AAAA" },
    ]);

    expect(messages).toHaveLength(2);
    const last = messages[1]!;
    expect(last.role).toBe("user");
    // The text matters as much as the image: a bare picture with no stated
    // relationship to the call above it gets answered about the wrong thing.
    expect(JSON.stringify(last.content)).toContain("browser_take_screenshot");
    expect(JSON.stringify(last.content)).toContain("AAAA");
  });

  test("several images ride in one message", () => {
    const messages = hoistImages(base, [
      { toolName: "a", mediaType: "image/png", data: "1" },
      { toolName: "b", mediaType: "image/jpeg", data: "2" },
    ]);
    expect(messages).toHaveLength(2);
    expect((messages[1]!.content as unknown[]).length).toBe(3);
  });

  test("no images means the same array back, untouched", () => {
    expect(hoistImages(base, [])).toBe(base);
  });
});

describe("needsImageHoist", () => {
  test("is the one branch that decides whether screenshots work", () => {
    expect(needsImageHoist("openai")).toBe(true);
    expect(needsImageHoist("anthropic")).toBe(false);
  });
});
