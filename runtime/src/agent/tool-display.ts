/**
 * How a tool call is named, described and sanitised.
 *
 * Shared by both agent engines. These decisions are about the product — what a
 * person sees in the transcript, what they are asked to vouch for — and not
 * about which SDK assembles the request, so keeping one copy is what stops the
 * two engines from quietly disagreeing about the same call.
 */

/** `mcp__playwright__browser_click` → `browser_click`. */
export function shortToolName(name: string): string {
  const [prefix, _server, ...toolName] = name.split("__");
  return prefix === "mcp" && toolName.length > 0 ? toolName.join("__") : name;
}

/**
 * The fully-qualified name the policy is written against.
 *
 * The Agent SDK hands tools over already prefixed; the AI SDK's MCP client
 * hands back the server's own bare names. The policy must not have to care —
 * a classification that silently stopped matching would turn every gated tool
 * into an automatic one.
 */
export function qualifyToolName(server: string, name: string): string {
  return name.startsWith("mcp__") ? name : `mcp__${server}__${name}`;
}

/**
 * Adjust what a tool was asked to do before it does it.
 *
 * Playwright MCP hands a screenshot back as an image only when no filename was
 * given; with one it writes the file into its own output directory and returns
 * a path instead. That directory belongs to the MCP process — nobody on our
 * side can reach it — and the picture reaches neither the person who asked for
 * it nor the model that took it, which then describes the page from memory.
 * Dropping the filename is what makes a screenshot an actual screenshot.
 */
export function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (shortToolName(toolName) !== "browser_take_screenshot" || !("filename" in input)) {
    return input;
  }
  const { filename: _dropped, ...rest } = input;
  return rest;
}

/** Extensions for the image types the browser tools can return. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * A one-line description of what a tool call will actually do.
 *
 * This is the entire basis on which someone approves or denies, so it has to
 * carry the specifics. An approval card reading only "browser_evaluate" asks
 * the user to vouch for code they cannot see, which teaches them to approve
 * reflexively — worse than not asking at all.
 */
export function summarize(toolName: string, input: Record<string, unknown>): string {
  const short = shortToolName(toolName);

  // Arbitrary code: show it, trimmed to one readable line.
  const code = ["function", "fn", "expression", "script", "pageFunction"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string");
  if (code) {
    const flattened = code.replace(/\s+/g, " ").trim();
    return `${short}: ${flattened.length > 160 ? `${flattened.slice(0, 157)}…` : flattened}`;
  }

  const url = typeof input.url === "string" ? input.url : undefined;
  if (url) return `${short}: ${url}`;

  const target = typeof input.element === "string" ? input.element : undefined;
  const text = typeof input.text === "string" ? input.text : undefined;
  if (target && text) return `${short}: ${target} — "${text.slice(0, 60)}"`;
  if (target) return `${short}: ${target}`;

  // Anything else: show whatever scalar arguments it carries.
  const scalars = Object.entries(input)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .slice(0, 3);
  return scalars.length > 0 ? `${short}: ${scalars.join(", ")}` : short;
}
