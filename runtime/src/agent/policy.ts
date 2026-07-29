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
  // Runs arbitrary JavaScript in the page. Allowed by choice: gating it
  // interrupted routine reads (checking a value the snapshot did not expose)
  // far more often than it caught anything risky. Destructive *clicks* are
  // still gated by name, and every evaluate call is shown in the activity
  // feed with its code, so it stays visible even though it is not blocked.
  "mcp__playwright__browser_evaluate",
]);

/**
 * Words that make a click destructive. A site profile can supply its own list —
 * "archive" may be routine in one application and irreversible in another.
 */
export const DEFAULT_DESTRUCTIVE_WORDS = [
  "delete",
  "remove",
  "cancel",
  "void",
  "discard",
  "archive",
  "revoke",
  "reset",
];

const ELEMENT_KEYS = ["element", "ref", "selector"] as const;

function buildPattern(words: string[]): RegExp {
  const escaped = words
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return /(?!)/; // matches nothing
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

const DEFAULT_PATTERN = buildPattern(DEFAULT_DESTRUCTIVE_WORDS);

export function classifyToolUse(
  toolName: string,
  input: Record<string, unknown>,
  destructiveWords?: string[] | null,
): "auto" | "approve" {
  if (!AUTO_TOOLS.has(toolName)) return "approve";

  if (toolName === "mcp__playwright__browser_click") {
    const pattern =
      destructiveWords && destructiveWords.length > 0
        ? buildPattern(destructiveWords)
        : DEFAULT_PATTERN;

    // Only the element being acted on is inspected — text the agent types into
    // a field can legitimately contain these words.
    for (const key of ELEMENT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && pattern.test(value)) return "approve";
    }
  }

  return "auto";
}
