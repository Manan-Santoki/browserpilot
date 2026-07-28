import { describe, expect, test } from "bun:test";
import { classifyToolUse } from "../src/agent/policy";

describe("classifyToolUse", () => {
  test("read-only browser tools run without approval", () => {
    expect(classifyToolUse("mcp__playwright__browser_snapshot", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_take_screenshot", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_navigate", { url: "https://x.test" })).toBe(
      "auto",
    );
  });

  test("ordinary clicks and typing run without approval", () => {
    expect(classifyToolUse("mcp__playwright__browser_click", { element: "Create PO button" })).toBe(
      "auto",
    );
    expect(
      classifyToolUse("mcp__playwright__browser_type", { element: "Supplier field", text: "KEI" }),
    ).toBe("auto");
  });

  test("clicks on destructive-sounding elements require approval", () => {
    for (const element of [
      "Delete purchase order",
      "Cancel Order",
      "Void invoice",
      "Remove item row",
      "permanently delete",
    ]) {
      expect(classifyToolUse("mcp__playwright__browser_click", { element })).toBe("approve");
    }
  });

  test("destructive wording is matched case-insensitively and inside longer labels", () => {
    expect(classifyToolUse("mcp__playwright__browser_click", { element: "DELETE" })).toBe("approve");
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "Yes, delete this program" }),
    ).toBe("approve");
  });

  test("a destructive word in typed text is not itself destructive", () => {
    expect(
      classifyToolUse("mcp__playwright__browser_type", {
        element: "Notes field",
        text: "cancelled by supplier",
      }),
    ).toBe("auto");
  });

  test("unknown or non-browser tools require approval by default", () => {
    expect(classifyToolUse("Bash", { command: "ls" })).toBe("approve");
    expect(classifyToolUse("mcp__playwright__browser_evaluate", { fn: "() => 1" })).toBe("approve");
  });

  test("missing or non-string element is handled without throwing", () => {
    expect(classifyToolUse("mcp__playwright__browser_click", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_click", { element: 42 })).toBe("auto");
  });
});
