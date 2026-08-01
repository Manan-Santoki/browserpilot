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
import {
  PROVIDER_KEYS,
  resolveProviderSettings,
  type ProviderEnv,
  type ProviderSettings,
} from "./agent/provider-settings";
import {
  STORAGE_KEYS,
  resolveStorageSettings,
  type StorageEnv,
  type StorageSettings,
} from "./storage/settings";

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

export type ResumableSession = {
  id: string;
  userId: string;
  siteProfileId: string | null;
  kind: "agent" | "login";
  status: SessionStatus;
  title: string | null;
  model: string | null;
  lastUrl: string | null;
  lastUserMessage: string | null;
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
    /**
     * Model to fall back on before an admin has chosen one. Follows the
     * configured provider, so a gateway deployment does not start out naming
     * a Claude model the gateway has never heard of.
     */
    private fallbackModel?: string,
  ) {
    this.db = createDatabase(databaseUrl);
  }

  async settings(): Promise<RuntimeSettings> {
    const rows = await this.db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable);
    return parseSettings(rows, this.fallbackModel);
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

  /**
   * Where this deployment keeps downloads, from the environment and whatever
   * an administrator has saved. The secret is unsealed here because this is
   * the only object holding the master key.
   */
  async storageSettings(env: StorageEnv): Promise<StorageSettings> {
    const rows = await this.db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(inArray(settingsTable.key, [...STORAGE_KEYS]));

    return resolveStorageSettings(rows, env, (sealed) => decryptSecret(sealed, this.masterKey));
  }

  /**
   * Which Messages API the agent talks to, from the same two sources. Null
   * when nothing usable is configured — the caller decides what to do about
   * that, because a runtime with no provider can still serve its files and
   * its existing sessions.
   */
  async providerSettings(env: ProviderEnv): Promise<ProviderSettings | null> {
    const rows = await this.db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(inArray(settingsTable.key, [...PROVIDER_KEYS]));

    return resolveProviderSettings(rows, env, (sealed) => decryptSecret(sealed, this.masterKey));
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
    model?: string;
    resumedFromSessionId?: string;
    lastUrl?: string;
    lastUserMessage?: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(robotSessions)
      .values({
        userId: input.userId,
        siteProfileId: input.siteProfileId,
        status: "starting",
        title: input.title ?? null,
        kind: input.kind ?? "agent",
        model: input.model ?? null,
        resumedFromSessionId: input.resumedFromSessionId ?? null,
        lastUrl: input.lastUrl ?? null,
        lastUserMessage: input.lastUserMessage ?? null,
      })
      .returning({ id: robotSessions.id });
    return row!.id;
  }

  /** Load the durable fields needed to create a continuation after its browser is gone. */
  async resumableSession(sessionId: string): Promise<ResumableSession | null> {
    const [row] = await this.db
      .select({
        id: robotSessions.id,
        userId: robotSessions.userId,
        siteProfileId: robotSessions.siteProfileId,
        kind: robotSessions.kind,
        status: robotSessions.status,
        title: robotSessions.title,
        model: robotSessions.model,
        lastUrl: robotSessions.lastUrl,
        lastUserMessage: robotSessions.lastUserMessage,
      })
      .from(robotSessions)
      .where(eq(robotSessions.id, sessionId))
      .limit(1);
    return row ?? null;
  }

  /** A source has at most one direct continuation, keeping resume history linear. */
  async continuationFor(sessionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: robotSessions.id })
      .from(robotSessions)
      .where(eq(robotSessions.resumedFromSessionId, sessionId))
      .limit(1);
    return row?.id ?? null;
  }

  /** Save only the state that can be restored safely in a fresh browser. */
  async checkpointSession(
    sessionId: string,
    checkpoint: { lastUrl?: string; lastUserMessage?: string },
  ): Promise<void> {
    if (checkpoint.lastUrl === undefined && checkpoint.lastUserMessage === undefined) return;
    await this.db
      .update(robotSessions)
      .set({
        ...(checkpoint.lastUrl !== undefined ? { lastUrl: checkpoint.lastUrl } : {}),
        ...(checkpoint.lastUserMessage !== undefined
          ? { lastUserMessage: checkpoint.lastUserMessage }
          : {}),
        lastActivityAt: new Date(),
      })
      .where(eq(robotSessions.id, sessionId));
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

  /** Append to the durable transcript with an atomic per-session sequence number. */
  async appendEvent(
    sessionId: string,
    event: RobotEvent,
    checkpoint: { lastUrl?: string; lastUserMessage?: string } = {},
  ): Promise<void> {
    // Updating the parent row is the lock: concurrent statements for one
    // session queue inside Postgres, each receives the counter value after the
    // previous update, and inserts with no unique-key race or extra round trip.
    await this.db.execute(sql`
      with next_event as (
        update "robot_sessions"
        set "event_seq" = "event_seq" + 1,
            "last_activity_at" = now(),
            "last_url" = coalesce(${checkpoint.lastUrl ?? null}, "last_url"),
            "last_user_message" = coalesce(
              ${checkpoint.lastUserMessage ?? null},
              "last_user_message"
            )
        where "id" = ${sessionId}::uuid
        returning "event_seq"
      )
      insert into "session_events" ("robot_session_id", "seq", "type", "payload")
      select ${sessionId}::uuid, next_event."event_seq", ${event.type}, ${JSON.stringify(event)}::jsonb
      from next_event
    `);
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
