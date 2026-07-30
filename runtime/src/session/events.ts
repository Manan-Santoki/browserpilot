import type { RemoteInput } from "../browser/input";

export type SessionStatus =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_approval"
  | "stopped"
  | "failed"
  /** Was live when the runtime restarted, so its browser is gone. */
  | "interrupted";

export type ChoiceOption = {
  label: string;
  value: string;
  description?: string;
};

export type RobotEvent =
  | { type: "session_status"; status: SessionStatus; detail?: string }
  /** What the user said. Stored so a reloaded page shows both sides. */
  | { type: "user_msg"; text: string }
  | { type: "agent_text"; text: string }
  | { type: "tool_activity"; tool: string; summary: string }
  | { type: "approval_request"; requestId: string; tool: string; summary: string }
  | { type: "approval_resolved"; requestId: string; approved: boolean }
  | {
      type: "choice_request";
      requestId: string;
      question: string;
      options: ChoiceOption[];
    }
  | {
      type: "choice_resolved";
      requestId: string;
      value: string;
      label: string;
    }
  | { type: "file_ready"; fileId: string; filename: string; url: string }
  /** A picture the agent took, to be shown in the conversation rather than linked. */
  | { type: "screenshot"; filename: string; url: string }
  /** Whether frames are flowing, so a reconnecting client's toggle tells the truth. */
  | { type: "preview_state"; enabled: boolean }
  | { type: "error"; message: string };

/**
 * Where a client fetches a file this session produced.
 *
 * Runtime-relative on purpose: the console proxies the path under its own
 * origin so the link carries the user's cookie instead of needing a ticket.
 */
export function sessionFileUrl(sessionId: string, filename: string): string {
  return `/api/sessions/${sessionId}/files/${encodeURIComponent(filename)}`;
}

export type ClientCommand =
  | { type: "user_msg"; text: string }
  | { type: "approval"; requestId: string; approved: boolean }
  | { type: "choice"; requestId: string; value: string }
  | { type: "preview"; enabled: boolean }
  // How large the viewer is showing the stream, so the sharp frame is taken at
  // the resolution it will actually be displayed at and no larger.
  | { type: "viewport"; cssWidth: number; pixelRatio: number }
  // Frames go out as binary by default. A client that would rather decode text
  // — React Native, where binary frames are awkward — asks for base64 instead.
  | { type: "frame_encoding"; encoding: "binary" | "base64" }
  // Only a sign-in session accepts these: the person driving the browser.
  | { type: "input"; event: RemoteInput }
  | { type: "stop" };
