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
  return mintTicket(
    { sessionId, userId: user.id, role: user.role, perms: user.perms },
    ticketSecret(),
  );
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
): Promise<
  { ok: true; data: T } | { ok: false; status: number; error: string; code?: string }
> {
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
      code: typeof body.code === "string" ? body.code : undefined,
    };
  }
  return { ok: true, data: body as T };
}

export function listRuntimeSessions(user: CurrentUser) {
  return call<{ sessions: RuntimeSession[] }>(user, "/api/sessions");
}

export function startRuntimeSession(
  user: CurrentUser,
  siteProfileId: string,
  title?: string,
  model?: string,
) {
  return call<{ id: string }>(user, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ siteProfileId, title, model }),
  });
}

export type StorageStatus = {
  driver: "local" | "s3";
  endpoint?: string;
  bucket?: string;
  region?: string;
  /** Proven by writing a probe object and reading it back, not asserted. */
  reachable: boolean;
  error?: string;
};

/** Where the runtime is actually putting files right now. */
export function runtimeStorageStatus(user: CurrentUser) {
  return call<StorageStatus>(user, "/api/storage");
}

export type ProviderStatus = {
  configured: boolean;
  format?: "anthropic" | "openai";
  /** Named rather than blank when it is Anthropic's own API. */
  endpoint?: string;
  credentialKind?: "oauth" | "apiKey" | "authToken";
  models?: Array<{ value: string; label: string; vision: boolean; format?: "anthropic" | "openai" }>;
  /** Which model was probed. Absent when nothing was configured to probe. */
  model?: string;
  /** Proven with a one-token request, not asserted. */
  reachable?: boolean;
  /** The provider answered but is out of quota — still correctly wired. */
  rateLimited?: boolean;
  latencyMs?: number;
  error?: string;
};

/**
 * What the runtime would use for the next session, checked against the
 * provider. `model` probes one entry of the catalogue rather than the default.
 */
export function runtimeProviderStatus(user: CurrentUser, model?: string) {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  return call<ProviderStatus>(user, `/api/provider${query}`);
}

/** Open a browser for the person to sign in to a site themselves. */
export function startRuntimeLogin(user: CurrentUser, siteProfileId: string) {
  return call<{ id: string }>(user, "/api/logins", {
    method: "POST",
    body: JSON.stringify({ siteProfileId }),
  });
}

/** Keep the profile the sign-in produced, and close its browser. */
export function saveRuntimeLogin(user: CurrentUser, sessionId: string) {
  return call<{ ok: boolean }>(user, `/api/logins/${sessionId}/save`, {
    method: "POST",
    sessionId,
  });
}

/** Replace a session's browser without ending the session. */
export function restartRuntimeBrowser(user: CurrentUser, sessionId: string) {
  return call<{ ok: boolean }>(user, `/api/sessions/${sessionId}/restart`, {
    method: "POST",
    sessionId,
  });
}

export function stopRuntimeSession(user: CurrentUser, sessionId: string) {
  return call<{ ok: boolean }>(user, `/api/sessions/${sessionId}/stop`, {
    method: "POST",
    sessionId,
  });
}

/** Start a linked continuation of an ended session. */
export function resumeRuntimeSession(user: CurrentUser, sessionId: string) {
  return call<{ id: string; resumedFromSessionId: string }>(
    user,
    `/api/sessions/${sessionId}/resume`,
    {
      method: "POST",
      sessionId,
    },
  );
}

/** Public URL the browser should open its WebSocket against. */
export function runtimeWsUrl(sessionId: string, ticket: string): string {
  const base = RUNTIME_URL.replace(/^http/, "ws");
  return `${base}/ws/${sessionId}?ticket=${encodeURIComponent(ticket)}`;
}

export function runtimeHttpUrl(): string {
  return RUNTIME_URL;
}

/** Upload a private candidate document without routing its bytes through the database. */
export async function uploadJobDocument(
  user: CurrentUser,
  documentId: string,
  file: File,
): Promise<{ ok: true; data: { key: string; filename: string; size: number; contentType: string; encryptionAad: string; extractedTextEncrypted: string } } | { ok: false; error: string }> {
  const ticket = await ticketFor(user, "pending");
  const form = new FormData();
  form.set("documentId", documentId);
  form.set("file", file);
  try {
    const response = await fetch(`${RUNTIME_URL}/api/job-documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}` },
      body: form,
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: String(body.error ?? "Upload failed") };
    return { ok: true, data: body as { key: string; filename: string; size: number; contentType: string; encryptionAad: string; extractedTextEncrypted: string } };
  } catch (error) {
    return { ok: false, error: `The browser service is unreachable (${(error as Error).message})` };
  }
}

export async function fetchJobDocument(user: CurrentUser, documentId: string): Promise<Response> {
  const ticket = await ticketFor(user, "pending");
  return fetch(`${RUNTIME_URL}/api/job-documents/${documentId}`, {
    headers: { authorization: `Bearer ${ticket}` },
    cache: "no-store",
  });
}

export async function deleteJobDocument(user: CurrentUser, documentId: string): Promise<boolean> {
  const ticket = await ticketFor(user, "pending");
  const response = await fetch(`${RUNTIME_URL}/api/job-documents/${documentId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ticket}` },
    cache: "no-store",
  }).catch(() => null);
  return Boolean(response?.ok);
}

export async function sendJobAnswer(
  user: CurrentUser,
  sessionId: string,
  requestId: string,
  value: string | number | boolean | string[],
): Promise<boolean> {
  const ticket = await ticketFor(user, sessionId);
  const response = await fetch(`${RUNTIME_URL}/api/sessions/${sessionId}/job-answer`, {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, value }),
    cache: "no-store",
  }).catch(() => null);
  return Boolean(response?.ok);
}

export async function finishJobTakeover(user: CurrentUser, sessionId: string, requestId: string): Promise<boolean> {
  const ticket = await ticketFor(user, sessionId);
  const response = await fetch(`${RUNTIME_URL}/api/sessions/${sessionId}/takeover`, {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, enabled: true }),
    cache: "no-store",
  }).catch(() => null);
  return Boolean(response?.ok);
}
