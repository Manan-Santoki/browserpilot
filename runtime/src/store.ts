import { and, asc, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@browserpilot/core";
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
import type { SavedCookie } from "./browser/chromium";
import type { RobotEvent, SessionStatus } from "./session/events";
import { parseSettings, type RuntimeSettings } from "./settings";

/** Statuses that count as "still holding a browser" for the concurrency caps. */
export const LIVE_STATUSES = ["starting", "idle", "working", "awaiting_approval"] as const;

/** Once a session reaches one of these it is over, and stays over. */
export const TERMINAL_STATUSES = ["stopped", "failed", "interrupted"] as const;

export type TargetSite = {
  id: string;
  name: string;
  baseUrl: string;
  loginStrategy: "cookie_mint" | "persistent_profile" | "manual_login";
  cookieName: string;
  /** Marks a page as signed out, for saved logins that have expired. */
  loggedOutPattern: string | null;
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

/**
 * How this person reaches the target site.
 *
 * A cookie_mint site needs the identity to forge. A saved-login site needs
 * none of that — the profile on disk already holds a real session — so only
 * `linkState` matters there.
 */
export type TargetAccount = {
  targetUserId: string | null;
  targetEmail: string | null;
  targetName: string | null;
  targetRole: string | null;
  linkState: "none" | "linked" | "expired";
  /** Decrypted only in memory, only when a session starts. */
  cookies: SavedCookie[] | null;
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
      loggedOutPattern: row.loggedOutPattern,
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
        linkState: siteAccounts.linkState,
        cookiesEncrypted: siteAccounts.cookiesEncrypted,
      })
      .from(siteAccounts)
      .where(and(eq(siteAccounts.userId, userId), eq(siteAccounts.siteProfileId, siteProfileId)))
      .limit(1);

    if (!row) return null;

    const { cookiesEncrypted, ...account } = row;
    let cookies: SavedCookie[] | null = null;
    if (cookiesEncrypted) {
      try {
        cookies = JSON.parse(decryptSecret(cookiesEncrypted, this.masterKey)) as SavedCookie[];
      } catch {
        // A profile that cannot be unsealed is a profile that must be redone,
        // which the person will be told when the target bounces them.
        cookies = null;
      }
    }

    return { ...account, cookies };
  }

  /** Keep the cookies a sign-in produced, sealed with the master key. */
  async saveCookies(userId: string, siteProfileId: string, cookies: SavedCookie[]): Promise<void> {
    await this.db
      .update(siteAccounts)
      .set({ cookiesEncrypted: encryptSecret(JSON.stringify(cookies), this.masterKey) })
      .where(and(eq(siteAccounts.userId, userId), eq(siteAccounts.siteProfileId, siteProfileId)));
  }

  /**
   * Who owns a session, whether or not it is still running.
   *
   * Downloads outlive their session on disk, so serving them cannot depend on
   * the in-memory registry — but it must still be an ownership check.
   */
  async sessionOwner(sessionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: robotSessions.userId })
      .from(robotSessions)
      .where(eq(robotSessions.id, sessionId))
      .limit(1);
    return row?.userId ?? null;
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
    kind?: "agent" | "login";
  }): Promise<string> {
    const [row] = await this.db
      .insert(robotSessions)
      .values({
        userId: input.userId,
        siteProfileId: input.siteProfileId,
        status: "starting",
        title: input.title ?? null,
        kind: input.kind ?? "agent",
      })
      .returning({ id: robotSessions.id });
    return row!.id;
  }

  /** Record whether this person currently holds a working login for a site. */
  async setLinkState(
    userId: string,
    siteProfileId: string,
    state: "none" | "linked" | "expired",
  ): Promise<void> {
    await this.db
      .update(siteAccounts)
      .set({ linkState: state, linkedAt: state === "linked" ? new Date() : null })
      .where(and(eq(siteAccounts.userId, userId), eq(siteAccounts.siteProfileId, siteProfileId)));
  }

  /** Note that a finished session wrote its session state back to the profile. */
  async markSynced(userId: string, siteProfileId: string): Promise<void> {
    await this.db
      .update(siteAccounts)
      .set({ lastSyncedAt: new Date() })
      .where(and(eq(siteAccounts.userId, userId), eq(siteAccounts.siteProfileId, siteProfileId)));
  }

  /**
   * Move a session to a new status, unless it has already finished.
   *
   * A restarting runtime declares the previous run's sessions interrupted, but
   * the process it replaced can still be alive for a moment and still writing.
   * Without this guard those writes put a dead session back into a live status
   * while its endedAt stayed set — a row no sweep would look at again and no
   * stop request could reach, because no runtime held it any more.
   */
  async setStatus(sessionId: string, status: SessionStatus, reason?: string): Promise<void> {
    const ended = TERMINAL_STATUSES.includes(status as (typeof TERMINAL_STATUSES)[number]);
    await this.db
      .update(robotSessions)
      .set({
        status,
        lastActivityAt: new Date(),
        ...(ended ? { endedAt: new Date(), endedReason: reason ?? null } : {}),
      })
      .where(
        and(
          eq(robotSessions.id, sessionId),
          notInArray(robotSessions.status, [...TERMINAL_STATUSES]),
        ),
      );
  }

  /**
   * End a session the runtime no longer holds.
   *
   * Whatever the reason a browser went away — a restart, a crash — the row it
   * left behind is one a person still sees as running, and it counts against
   * their concurrency limit. They must always be able to clear it.
   */
  async forceStop(sessionId: string, reason: string): Promise<boolean> {
    const rows = await this.db
      .update(robotSessions)
      .set({ status: "stopped", endedAt: new Date(), endedReason: reason })
      .where(
        and(
          eq(robotSessions.id, sessionId),
          inArray(robotSessions.status, [...LIVE_STATUSES]),
        ),
      )
      .returning({ id: robotSessions.id });
    return rows.length > 0;
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
      .where(inArray(robotSessions.status, [...LIVE_STATUSES]))
      .returning({ id: robotSessions.id });
    return rows.length;
  }
}
