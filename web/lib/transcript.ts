import "server-only";
import { asc, eq } from "drizzle-orm";
import { sessionEvents } from "@browserpilot/db";
import { db } from "./db";

export type ChatItem =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | {
      kind: "voice_user";
      text: string;
      inputModality: "text" | "audio";
      outputModality: "text" | "audio";
    }
  | {
      kind: "voice_assistant";
      text: string;
      inputModality: "text" | "audio";
      outputModality: "text" | "audio";
    }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "file"; filename: string; url: string }
  /** A picture the agent took, shown in the conversation rather than linked. */
  | { kind: "screenshot"; filename: string; url: string }
  | { kind: "approval"; requestId: string; summary: string; resolved?: "approved" | "denied" }
  | {
      kind: "choice";
      requestId: string;
      question: string;
      options: Array<{ label: string; value: string; description?: string }>;
      resolved?: { label: string; value: string };
    };

type StoredEvent = {
  type?: string;
  text?: string;
  tool?: string;
  summary?: string;
  message?: string;
  filename?: string;
  url?: string;
  requestId?: string;
  approved?: boolean;
  question?: string;
  options?: Array<{ label?: string; value?: string; description?: string }>;
  value?: string;
  label?: string;
  speaker?: string;
  inputModality?: string;
  outputModality?: string;
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
  let downloadComplete = false;

  for (const row of rows) {
    const event = row.payload as StoredEvent;

    switch (event.type) {
      case "user_msg":
        if (event.text) {
          downloadComplete = false;
          items.push({ kind: "you", text: event.text });
        }
        break;
      case "agent_text":
        if (event.text) items.push({ kind: "agent", text: event.text });
        break;
      case "voice_transcript":
        if (
          event.text &&
          ["user", "assistant"].includes(event.speaker ?? "") &&
          ["text", "audio"].includes(event.inputModality ?? "") &&
          ["text", "audio"].includes(event.outputModality ?? "")
        ) {
          items.push({
            kind: event.speaker === "assistant" ? "voice_assistant" : "voice_user",
            text: event.text,
            inputModality: event.inputModality as "text" | "audio",
            outputModality: event.outputModality as "text" | "audio",
          });
        }
        break;
      case "tool_activity":
        if (
          event.summary &&
          event.tool !== "browser_run_code_unsafe" &&
          !(downloadComplete && event.tool?.startsWith("browser_"))
        ) {
          items.push({ kind: "tool", text: event.summary });
        }
        break;
      case "error":
        if (event.message) items.push({ kind: "error", text: event.message });
        break;
      case "file_ready":
        if (event.filename && event.url) {
          downloadComplete = true;
          const alreadyShown = items.some(
            (item) =>
              item.kind === "file" &&
              (item.url === event.url || item.filename === event.filename),
          );
          if (!alreadyShown) {
            items.push({ kind: "file", filename: event.filename, url: event.url });
          }
        }
        break;
      case "screenshot":
        if (event.filename && event.url) {
          items.push({ kind: "screenshot", filename: event.filename, url: event.url });
        }
        break;
      case "approval_request":
        if (
          event.requestId &&
          event.tool !== "browser_run_code_unsafe" &&
          !(downloadComplete && event.tool?.startsWith("browser_"))
        ) {
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
      case "choice_request":
        if (event.requestId && event.question && Array.isArray(event.options)) {
          const options = event.options
            .filter(
              (option): option is { label: string; value: string; description?: string } =>
                typeof option.label === "string" && typeof option.value === "string",
            )
            .map((option) => ({
              label: option.label,
              value: option.value,
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            }));
          if (options.length > 0) {
            items.push({
              kind: "choice",
              requestId: event.requestId,
              question: event.question,
              options,
            });
          }
        }
        break;
      case "choice_resolved": {
        const target = items.find(
          (item) => item.kind === "choice" && item.requestId === event.requestId,
        );
        if (
          target &&
          target.kind === "choice" &&
          typeof event.value === "string" &&
          typeof event.label === "string"
        ) {
          target.resolved = { value: event.value, label: event.label };
        }
        break;
      }
      default:
        break;
    }
  }

  return items;
}
