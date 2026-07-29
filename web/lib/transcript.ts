import "server-only";
import { asc, eq } from "drizzle-orm";
import { sessionEvents } from "@browserpilot/db";
import { db } from "./db";

export type ChatItem =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "file"; filename: string; url: string }
  /** A picture the agent took, shown in the conversation rather than linked. */
  | { kind: "screenshot"; filename: string; url: string }
  | { kind: "approval"; requestId: string; summary: string; resolved?: "approved" | "denied" };

type StoredEvent = {
  type?: string;
  text?: string;
  summary?: string;
  message?: string;
  filename?: string;
  url?: string;
  requestId?: string;
  approved?: boolean;
};

/**
 * Rebuild a session's conversation from the durable transcript.
 *
 * Without this a reload showed an empty chat even while the session was still
 * running — and an approval waiting for an answer was invisible, leaving the
 * session stuck with no way to unstick it.
 */
export async function loadTranscript(sessionId: string): Promise<ChatItem[]> {
  const rows = await db()
    .select({ payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(eq(sessionEvents.robotSessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));

  const items: ChatItem[] = [];

  for (const row of rows) {
    const event = row.payload as StoredEvent;

    switch (event.type) {
      case "user_msg":
        if (event.text) items.push({ kind: "you", text: event.text });
        break;
      case "agent_text":
        if (event.text) items.push({ kind: "agent", text: event.text });
        break;
      case "tool_activity":
        if (event.summary) items.push({ kind: "tool", text: event.summary });
        break;
      case "error":
        if (event.message) items.push({ kind: "error", text: event.message });
        break;
      case "file_ready":
        if (event.filename && event.url) {
          items.push({ kind: "file", filename: event.filename, url: event.url });
        }
        break;
      case "screenshot":
        if (event.filename && event.url) {
          items.push({ kind: "screenshot", filename: event.filename, url: event.url });
        }
        break;
      case "approval_request":
        if (event.requestId) {
          items.push({
            kind: "approval",
            requestId: event.requestId,
            summary: event.summary ?? "",
          });
        }
        break;
      case "approval_resolved": {
        // Mark the matching request rather than adding a line of its own.
        const target = items.find(
          (item) => item.kind === "approval" && item.requestId === event.requestId,
        );
        if (target && target.kind === "approval") {
          target.resolved = event.approved ? "approved" : "denied";
        }
        break;
      }
      default:
        break;
    }
  }

  return items;
}
