/**
 * A saved login eventually expires, and the only thing the target tells us is
 * that it has put the browser back on its sign-in page. There is no standard
 * for that, so this is a heuristic — deliberately narrow, because calling a
 * working session expired is worse than missing an expired one, which the
 * person will notice within seconds of watching the robot flail.
 *
 * A site can override the guess with its own pattern.
 */

/** Paths that mean "sign in" on nearly every application. */
const DEFAULT_PATTERNS = [
  "/login",
  "/signin",
  "/sign-in",
  "/sign_in",
  "/auth/login",
  "/account/login",
  "/users/sign_in",
];

export function looksSignedOut(url: string, pattern?: string | null): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return false;
  }

  if (pattern && pattern.trim().length > 0) {
    const trimmed = pattern.trim();
    // A site may give either a plain substring or a regex; a bad regex must not
    // take the session down, so fall back to treating it as a substring.
    try {
      return new RegExp(trimmed, "i").test(url);
    } catch {
      return url.toLowerCase().includes(trimmed.toLowerCase());
    }
  }

  return DEFAULT_PATTERNS.some((candidate) => path.startsWith(candidate) || path === candidate);
}
