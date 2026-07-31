import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Talking to the console.
 *
 * The phone holds two credentials. The device token comes from pairing, lives
 * in the platform keystore, and is only ever sent to one endpoint. It buys a
 * session token, which is what every other request carries and which expires on
 * its own — so a phone left in a taxi stops working without anyone having to
 * revoke anything, and revoking the device stops it sooner.
 */

const DEVICE_TOKEN_KEY = "browserpilot.deviceToken";
const SESSION_TOKEN_KEY = "browserpilot.sessionToken";
const CONSOLE_URL_KEY = "browserpilot.consoleUrl";

/**
 * Where the app looks unless it has been told otherwise.
 *
 * EXPO_PUBLIC_CONSOLE_URL is inlined at build time, which is how a development
 * build is pointed at a console running on the machine that built it. A release
 * build has no such variable and uses the hosted one.
 */
export const DEFAULT_CONSOLE_URL =
  process.env.EXPO_PUBLIC_CONSOLE_URL ?? "https://browserpilot.msantoki.com";

/**
 * SecureStore is not implemented on web, where Expo runs during development.
 * Falling back keeps the app runnable there; the keystore is what matters on a
 * real phone, which is the only place a real token ever lives.
 */
const store = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      globalThis.localStorage?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === "web") {
      globalThis.localStorage?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export type Account = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "USER";
  preferredLanguage: string;
};

export async function consoleUrl(): Promise<string> {
  // A development build must be able to target its configured console even
  // when SecureStore still contains the URL from an earlier production
  // pairing. Release builds normally have no override and continue using the
  // paired URL.
  if (process.env.EXPO_PUBLIC_CONSOLE_URL) return DEFAULT_CONSOLE_URL;
  return (await store.get(CONSOLE_URL_KEY)) ?? DEFAULT_CONSOLE_URL;
}

export async function setConsoleUrl(url: string): Promise<void> {
  await store.set(CONSOLE_URL_KEY, url.replace(/\/+$/, ""));
}

export async function isPaired(): Promise<boolean> {
  return (await store.get(DEVICE_TOKEN_KEY)) !== null;
}

/** Trade a scanned pairing code for a device token, and keep it. */
export async function pair(code: string, deviceName: string): Promise<void> {
  const base = await consoleUrl();
  const res = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });

  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) {
    throw new Error(body.error ?? "That code was not accepted.");
  }

  await store.set(DEVICE_TOKEN_KEY, body.token);
  await store.remove(SESSION_TOKEN_KEY);
}

export async function unpair(): Promise<void> {
  await store.remove(DEVICE_TOKEN_KEY);
  await store.remove(SESSION_TOKEN_KEY);
}

/** Exchange the device token for a fresh session. */
async function refreshSession(): Promise<string> {
  const deviceToken = await store.get(DEVICE_TOKEN_KEY);
  if (!deviceToken) throw new PairingRequired();

  const base = await consoleUrl();
  const res = await fetch(`${base}/api/device/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}` },
  });

  if (res.status === 401) {
    // Revoked, or the account was disabled. The device token is dead; holding
    // on to it would only produce the same failure on every screen.
    await unpair();
    throw new PairingRequired();
  }

  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? "Could not reach the console.");

  await store.set(SESSION_TOKEN_KEY, body.token);
  return body.token;
}

export class PairingRequired extends Error {
  constructor() {
    super("This phone is not paired.");
  }
}

/**
 * A request carrying the session token, renewing it once if it has expired.
 *
 * The retry is deliberately single: a second 401 means the device itself is no
 * longer accepted, and retrying that in a loop would spin.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = await consoleUrl();

  const call = async (token: string) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });

  let token = (await store.get(SESSION_TOKEN_KEY)) ?? (await refreshSession());
  let res = await call(token);

  if (res.status === 401) {
    token = await refreshSession();
    res = await call(token);
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return body as T;
}

/** The session token, for the places that need it in a URL rather than a header. */
export async function sessionToken(): Promise<string> {
  return (await store.get(SESSION_TOKEN_KEY)) ?? (await refreshSession());
}

export type RobotSession = {
  id: string;
  title: string | null;
  status: string;
  startedAt: string;
  endedReason: string | null;
  siteName: string | null;
  live: boolean;
};

export type Site = {
  id: string;
  name: string;
  baseUrl: string;
  loginStrategy: string;
  isActive: boolean;
  linkState: string | null;
  accountEmail: string | null;
  ready: boolean;
};

export type FileGroup = {
  sessionId: string;
  title: string;
  siteName: string | null;
  startedAt: string;
  files: Array<{ filename: string; url: string; at: string }>;
};

export const getSessions = () =>
  api<{ sessions: RobotSession[]; runtimeReachable: boolean }>("/api/sessions");

export const getSites = () => api<{ sites: Site[] }>("/api/sites");

export const getFiles = () => api<{ groups: FileGroup[] }>("/api/files");

export const startSession = (siteProfileId: string, title?: string) =>
  api<{ id: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ siteProfileId, title }),
  });

export const stopSession = (id: string) =>
  api<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: "POST" });

export const resumeSession = (id: string) =>
  api<{ id: string; resumedFromSessionId: string }>(`/api/sessions/${id}/resume`, {
    method: "POST",
  });

export const getSessionStatus = (id: string) =>
  api<{
    status: string;
    endedReason: string | null;
    resumedFromSessionId: string | null;
    continuationId: string | null;
  }>(`/api/sessions/${id}/status`);

export const getTicket = (id: string) =>
  api<{ url: string }>(`/api/sessions/${id}/ticket`, { method: "POST" });

export const getLiveToken = (id: string) =>
  api<{
    token: string;
    model: string;
    setup: Record<string, unknown>;
    expiresAt: string;
  }>(`/api/sessions/${id}/live-token`, { method: "POST" });

export type VoiceTranscriptMessage = {
  messageId: string;
  speaker: "user" | "assistant";
  text: string;
  inputModality: "text" | "audio";
  outputModality: "text" | "audio";
};

export const getTranscript = <T>(id: string) =>
  api<{ items: T[] }>(`/api/sessions/${id}/transcript`);

export const saveVoiceTranscript = (id: string, message: VoiceTranscriptMessage) =>
  api<{ saved: boolean }>(`/api/sessions/${id}/transcript`, {
    method: "POST",
    body: JSON.stringify({ kind: "transcript", ...message }),
  });

export const logVoiceTelemetry = (
  id: string,
  event: string,
  detail?: string,
  level: "info" | "warn" | "error" = "info",
) =>
  api<{ logged: boolean }>(`/api/sessions/${id}/transcript`, {
    method: "POST",
    body: JSON.stringify({ kind: "telemetry", event, detail, level }),
  });
