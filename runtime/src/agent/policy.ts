// Tools the agent may use freely. Everything else needs a human tap.
const AUTO_TOOLS = new Set([
  "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_navigate",
  "mcp__playwright__browser_navigate_back",
  "mcp__playwright__browser_find",
  "mcp__playwright__browser_hover",
  "mcp__playwright__browser_wait_for",
  "mcp__playwright__browser_press_key",
  "mcp__playwright__browser_resize",
  "mcp__playwright__browser_select_option",
  "mcp__playwright__browser_type",
  "mcp__playwright__browser_fill_form",
  "mcp__playwright__browser_click",
]);

// Only the element being acted on is inspected — text the agent types into a
// field can legitimately contain these words.
const DESTRUCTIVE_ELEMENT = /\b(delete|remove|cancel|void|discard|archive|revoke|reset)\b/i;

const ELEMENT_KEYS = ["element", "ref", "selector"] as const;

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
): "auto" | "approve" {
  if (!AUTO_TOOLS.has(toolName)) return "approve";

  if (toolName === "mcp__playwright__browser_click") {
    for (const key of ELEMENT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && DESTRUCTIVE_ELEMENT.test(value)) return "approve";
    }
  }

  return "auto";
}
