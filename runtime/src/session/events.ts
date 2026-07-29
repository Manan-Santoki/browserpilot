export type SessionStatus =
  | "starting"
  | "idle"
  | "working"
  | "awaiting_approval"
  | "stopped"
  | "failed"
  /** Was live when the runtime restarted, so its browser is gone. */
  | "interrupted";

export type RobotEvent =
  | { type: "session_status"; status: SessionStatus; detail?: string }
  | { type: "agent_text"; text: string }
  | { type: "tool_activity"; tool: string; summary: string }
  | { type: "approval_request"; requestId: string; tool: string; summary: string }
  | { type: "approval_resolved"; requestId: string; approved: boolean }
  | { type: "file_ready"; fileId: string; filename: string; url: string }
  | { type: "error"; message: string };

export type ClientCommand =
  | { type: "user_msg"; text: string }
  | { type: "approval"; requestId: string; approved: boolean }
  | { type: "preview"; enabled: boolean }
  | { type: "stop" };
