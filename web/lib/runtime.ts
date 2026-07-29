import "server-only";
import { mintTicket } from "@browserpilot/core";
import type { CurrentUser } from "./session";

const RUNTIME_URL = process.env.BP_RUNTIME_URL ?? "http://127.0.0.1:8787";

function ticketSecret(): string {
  const secret = process.env.BP_TICKET_SECRET;
  if (!secret) throw new Error("BP_TICKET_SECRET is required");
  return secret;
}

/**
 * Mint a ticket for one session. The browser presents this when opening the
 * WebSocket, which is why it is scoped to a single session and expires quickly:
 * it travels in a URL, where it can end up in logs.
 */
export async function ticketFor(user: CurrentUser, sessionId: string): Promise<string> {
  return mintTicket({ sessionId, userId: user.id, role: user.role }, ticketSecret());
}

export type RuntimeSession = {
  id: string;
  userId: string;
  siteName: string;
  status: string;
  startedAt: number;
  lastActivityAt: number;
  previewEnabled: boolean;
};

async function call<T>(
  user: CurrentUser,
  path: string,
  init: RequestInit & { sessionId?: string } = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const ticket = await ticketFor(user, init.sessionId ?? "pending");

  let response: Response;
  try {
    response = await fetch(`${RUNTIME_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    // A runtime that is down should read as a plain sentence in the UI, not a
    // stack trace or an infinite spinner.
    return { ok: false, status: 503, error: `The browser service is unreachable (${(error as Error).message})` };
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === "string" ? body.error : `Request failed (${response.status})`,
    };
  }
  return { ok: true, data: body as T };
}

export function listRuntimeSessions(user: CurrentUser) {
  return call<{ sessions: RuntimeSession[] }>(user, "/api/sessions");
}

export function startRuntimeSession(user: CurrentUser, siteProfileId: string, title?: string) {
  return call<{ id: string }>(user, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ siteProfileId, title }),
  });
}

export function stopRuntimeSession(user: CurrentUser, sessionId: string) {
  return call<{ ok: boolean }>(user, `/api/sessions/${sessionId}/stop`, {
    method: "POST",
    sessionId,
  });
}

/** Public URL the browser should open its WebSocket against. */
export function runtimeWsUrl(sessionId: string, ticket: string): string {
  const base = RUNTIME_URL.replace(/^http/, "ws");
  return `${base}/ws/${sessionId}?ticket=${encodeURIComponent(ticket)}`;
}

export function runtimeHttpUrl(): string {
  return RUNTIME_URL;
}
