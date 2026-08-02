import "server-only";
import { and, eq } from "drizzle-orm";
import { robotSessions, sessionShares } from "@browserpilot/db";
import { db } from "./db";
import type { CurrentUser } from "./session";
import { can } from "./auth";

/**
 * Whether a user may see a session's page, transcript and files: the owner,
 * an admin, someone with `session.view_others`, or someone it was shared with.
 *
 * This is the console-side mirror of the runtime's `canView`. The runtime is
 * the authority on live sessions, but the console must gate its own read
 * endpoints (transcripts, files, tickets) before any WebSocket is opened.
 */
export async function canViewSession(user: CurrentUser, sessionId: string): Promise<boolean> {
  if (user.role === "ADMIN" || can(user, "session.view_others")) return true;

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, sessionId))
    .limit(1);
  if (!session) return false;
  if (session.userId === user.id) return true;

  const [share] = await db()
    .select({ id: sessionShares.id })
    .from(sessionShares)
    .where(and(eq(sessionShares.robotSessionId, sessionId), eq(sessionShares.userId, user.id)))
    .limit(1);
  return Boolean(share);
}

/** Whether a user may operate a session: owner or admin. */
export function canControlSession(user: CurrentUser, ownerId: string): boolean {
  return user.role === "ADMIN" || user.id === ownerId;
}
