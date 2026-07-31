import "server-only";
import { auditLogs } from "@browserpilot/db";
import { db } from "./db";

export type AuditAction =
  | "user.login"
  | "user.login_failed"
  | "user.logout"
  | "user.invited"
  | "user.invite_accepted"
  | "user.updated"
  | "site.created"
  | "site.updated"
  | "site.deleted"
  // Signing in to a target site by hand. Records that it happened and against
  // which site — never anything that was typed.
  | "site.login_started"
  | "site.login_saved"
  | "session.started"
  | "session.resumed"
  | "session.stopped"
  | "session.approval"
  | "device.paired"
  | "device.revoked"
  | "settings.updated";

/**
 * Append-only record of who did what. Never let a logging failure break the
 * action being logged — an audit gap is bad, a failed login flow is worse.
 */
export async function audit(entry: {
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db().insert(auditLogs).values({
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (error) {
    console.error("audit write failed", entry.action, error);
  }
}
