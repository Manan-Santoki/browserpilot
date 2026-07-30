import { describe, expect, test } from "bun:test";
import { classifyToolUse } from "../src/agent/policy";

describe("classifyToolUse", () => {
  test("read-only browser tools run without approval", () => {
    expect(classifyToolUse("mcp__playwright__browser_snapshot", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_take_screenshot", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_console_messages", { level: "error" })).toBe(
      "auto",
    );
    expect(
      classifyToolUse("mcp__playwright__browser_network_requests", { static: false }),
    ).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_network_request", { index: 1 })).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_navigate", { url: "https://x.test" })).toBe(
      "auto",
    );
  });

  test("listing or selecting an existing tab runs without approval", () => {
    expect(classifyToolUse("mcp__playwright__browser_tabs", { action: "list" })).toBe("auto");
    expect(
      classifyToolUse("mcp__playwright__browser_tabs", { action: "select", index: 1 }),
    ).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_tabs", { action: "new" })).toBe("approve");
    expect(
      classifyToolUse("mcp__playwright__browser_tabs", { action: "close", index: 1 }),
    ).toBe("approve");
  });

  test("asking the user to choose is handled by BrowserPilot, not the approval gate", () => {
    expect(
      classifyToolUse("mcp__browserpilot__ask_user_choice", {
        question: "Which transport?",
        options: [],
      }),
    ).toBe("auto");
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
    expect(classifyToolUse("mcp__playwright__browser_install", {})).toBe("approve");
  });

  test("unsafe arbitrary browser code is denied outright", () => {
    expect(
      classifyToolUse("mcp__playwright__browser_run_code_unsafe", {
        code: "async (page) => page.evaluate(() => document.cookie)",
      }),
    ).toBe("deny");
  });

  test("evaluate runs without approval, by explicit choice", () => {
    // Gating it interrupted routine reads far more than it caught risk.
    expect(classifyToolUse("mcp__playwright__browser_evaluate", { fn: "() => 1" })).toBe("auto");
  });

  test("missing or non-string element is handled without throwing", () => {
    expect(classifyToolUse("mcp__playwright__browser_click", {})).toBe("auto");
    expect(classifyToolUse("mcp__playwright__browser_click", { element: 42 })).toBe("auto");
  });

  test("a site can supply its own destructive vocabulary", () => {
    const words = ["scrap", "supersede"];
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "Scrap this batch" }, words),
    ).toBe("approve");
    // Its list replaces the default rather than extending it, so a word the
    // site considers routine stops blocking.
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "Archive record" }, words),
    ).toBe("auto");
  });

  test("an empty site list falls back to the defaults", () => {
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "Delete row" }, []),
    ).toBe("approve");
  });

  test("regex characters in a site word cannot break the matcher", () => {
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "a.b" }, ["a.b"]),
    ).toBe("approve");
    expect(
      classifyToolUse("mcp__playwright__browser_click", { element: "axb" }, ["a.b"]),
    ).toBe("auto");
  });
});
