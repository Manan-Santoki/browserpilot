import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { decryptSecret } from "@browserpilot/core";
import {
  createDatabase,
  robotSessions,
  sessionEvents,
  settings as settingsTable,
  siteAccounts,
  siteProfiles,
  users,
  type Database,
} from "@browserpilot/db";
import type { RobotEvent, SessionStatus } from "./session/events";
import { parseSettings, type RuntimeSettings } from "./settings";

/** Statuses that count as "still holding a browser" for the concurrency caps. */
export const LIVE_STATUSES = ["starting", "idle", "working", "awaiting_approval"] as const;

export type TargetSite = {
  id: string;
  name: string;
  baseUrl: string;
  loginStrategy: "cookie_mint" | "persistent_profile" | "manual_login";
  cookieName: string;
  /** Decrypted only in memory, only when a session starts. */
  secret: string | null;
  systemPromptNotes: string | null;
  destructivePatterns: string[] | null;
};

export type SessionOwner = {
  userId: string;
  email: string;
  name: string;
  role: string;
};

/** The identity the robot presents to the target site. */
export type TargetAccount = {
  targetUserId: string;
  targetEmail: string;
  targetName: string;
  targetRole: string;
};

export class Store {
  private db: Database;

  constructor(
    databaseUrl: string,
    private masterKey: string,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async settings(): Promise<RuntimeSettings> {
    const rows = await this.db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable);
    return parseSettings(rows);
  }

  /** Load a target and unseal its signing secret. Returns null if unknown or disabled. */
  async site(siteProfileId: string): Promise<TargetSite | null> {
    const [row] = await this.db
      .select()
      .from(siteProfiles)
      .where(and(eq(siteProfiles.id, siteProfileId), eq(siteProfiles.isActive, true)))
      .limit(1);

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      loginStrategy: row.loginStrategy,
      cookieName: row.cookieName,
      secret: row.secretEncrypted ? decryptSecret(row.secretEncrypted, this.masterKey) : null,
      systemPromptNotes: row.systemPromptNotes,
      destructivePatterns: row.destructivePatterns,
    };
  }

  async owner(userId: string): Promise<SessionOwner | null> {
    const [row] = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || !row.isActive) return null;
    return { userId: row.userId, email: row.email, name: row.name, role: row.role };
  }

  /**
   * The identity this user assumes on this site. Without one, cookie-mint has
   * no account to mint for and the session cannot start — which is the correct
   * failure: minting a guessed identity would either fail at the target or,
   * worse, impersonate the wrong person.
   */
  async siteAccount(userId: string, siteProfileId: string): Promise<TargetAccount | null> {
    const [row] = await this.db
      .select({
        targetUserId: siteAccounts.targetUserId,
        targetEmail: siteAccounts.targetEmail,
        targetName: siteAccounts.targetName,
        targetRole: siteAccounts.targetRole,
      })
      .from(siteAccounts)
      .where(and(eq(siteAccounts.userId, userId), eq(siteAccounts.siteProfileId, siteProfileId)))
      .limit(1);

    return row ?? null;
  }

  async liveSessionCount(userId?: string): Promise<number> {
    const live = inArray(robotSessions.status, [...LIVE_STATUSES]);
    const [row] = await this.db
      .select({ n: count() })
      .from(robotSessions)
      .where(userId ? and(live, eq(robotSessions.userId, userId)) : live);
    return row?.n ?? 0;
  }

  async createSession(input: {
    userId: string;
    siteProfileId: string;
    title?: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(robotSessions)
      .values({
        userId: input.userId,
        siteProfileId: input.siteProfileId,
        status: "starting",
        title: input.title ?? null,
      })
      .returning({ id: robotSessions.id });
    return row!.id;
  }

  async setStatus(sessionId: string, status: SessionStatus, reason?: string): Promise<void> {
    const ended = status === "stopped" || status === "failed" || status === "interrupted";
    await this.db
      .update(robotSessions)
      .set({
        status,
        lastActivityAt: new Date(),
        ...(ended ? { endedAt: new Date(), endedReason: reason ?? null } : {}),
      })
      .where(eq(robotSessions.id, sessionId));
  }

  async touch(sessionId: string): Promise<void> {
    await this.db
      .update(robotSessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(robotSessions.id, sessionId));
  }

  /**
   * Append to the durable transcript. The sequence number is derived in SQL so
   * concurrent writers cannot both claim the same slot — the unique index on
   * (session, seq) would reject the second one.
   */
  async appendEvent(sessionId: string, event: RobotEvent): Promise<void> {
    await this.db.insert(sessionEvents).values({
      robotSessionId: sessionId,
      seq: sql`(select coalesce(max(${sessionEvents.seq}), 0) + 1 from ${sessionEvents} where ${sessionEvents.robotSessionId} = ${sessionId})`,
      type: event.type,
      payload: event,
    });
  }

  async events(sessionId: string, afterSeq = 0): Promise<Array<{ seq: number; payload: RobotEvent }>> {
    const rows = await this.db
      .select({ seq: sessionEvents.seq, payload: sessionEvents.payload })
      .from(sessionEvents)
      .where(eq(sessionEvents.robotSessionId, sessionId))
      .orderBy(asc(sessionEvents.seq));

    return rows
      .filter((r) => r.seq > afterSeq)
      .map((r) => ({ seq: r.seq, payload: r.payload as RobotEvent }));
  }

  /**
   * Sessions left "live" in the database by a crash or restart no longer have a
   * browser behind them. Mark them interrupted at boot so they neither show as
   * running in the console nor count against the concurrency caps.
   */
  async markOrphansInterrupted(): Promise<number> {
    const rows = await this.db
      .update(robotSessions)
      .set({
        status: "interrupted",
        endedAt: new Date(),
        endedReason: "runtime restarted",
      })
      .where(and(inArray(robotSessions.status, [...LIVE_STATUSES]), isNull(robotSessions.endedAt)))
      .returning({ id: robotSessions.id });
    return rows.length;
  }
}
