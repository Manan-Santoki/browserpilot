/**
 * Where a model provider lives, in a form both services agree on.
 *
 * Shared because the console validates what an administrator types and the
 * runtime validates what it reads back — and if those two disagreed, a URL
 * would be accepted by the form and rejected at the only moment that matters.
 */

/**
 * The base the client appends `/v1/messages` (or `/v1/chat/completions`) to.
 *
 * Gateways document their endpoint *including* that suffix, so it is the
 * natural thing to paste in — and it yields `/v1/messages/v1/messages` and a
 * 404 nobody reads twice. Trim it back rather than making whoever configured
 * it guess which half we meant.
 */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The provider base URL must be absolute, e.g. https://opencode.ai/zen/go");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The provider base URL must be http or https");
  }

  return trimmed.replace(/\/v1(\/messages|\/chat\/completions)?$/, "");
}
