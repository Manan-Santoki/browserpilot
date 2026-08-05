import { and, asc, count, desc, eq, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import {
  decryptBinary,
  decryptSecret,
  decryptStructured,
  encryptBinary,
  encryptSecret,
  encryptStructured,
  generatePortalPassword,
  hasSubmissionEvidence,
  jobAnswerMatchCandidates,
  jobAnswerMatchKey,
  jobOptionSignature,
  notificationRetryAt,
  validateJobAnswer,
  validateApplicationInventory,
  type ApplicationInventory,
  type JobAnswerType,
  type SubmissionEvidence,
} from "@browserpilot/core";
import {
  createDatabase,
  jobAnswers,
  jobApplicationEvents,
  jobApplications,
  jobCandidateProfiles,
  jobConsents,
  jobConnections,
  jobDocuments,
  jobPortalAccounts,
  jobQuestions,
  notificationOutbox,
  robotSessions,
  sessionEvents,
  sessionShares,
  settings as settingsTable,
  siteAccounts,
  siteProfiles,
  userPermissions,
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
  /** The person's saved model preference, applied when no per-session pick. */
  preferredModel?: string | null;
};

export type ResumableSession = {
  id: string;
  userId: string;
  siteProfileId: string | null;
  kind: "agent" | "login" | "job";
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

export type ClaimedJobApplication = {
  id: string;
  userId: string;
  sourceUrl: string;
  normalizedUrl: string;
  atsKind: string;
  model: string | null;
  resumeDocumentId: string | null;
  reapplyRequested: boolean;
  attempt: number;
};

export type StagedJobDocument = {
  id: string;
  filename: string;
  objectKey: string;
  contentType: string;
  encryptionAad: string;
};

const CANDIDATE_FIELD_ALIASES: Record<string, string> = {
  name: "fullName",
  fullname: "fullName",
  firstname: "firstName",
  givenname: "firstName",
  lastname: "lastName",
  familyname: "lastName",
  surname: "lastName",
  email: "applicationEmail",
  emailaddress: "applicationEmail",
  applicationemail: "applicationEmail",
  notificationemail: "notificationEmail",
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  mobilephone: "phone",
  linkedin: "linkedin",
  linkedinprofile: "linkedin",
  linkedinurl: "linkedin",
  github: "github",
  githubprofile: "github",
  githuburl: "github",
  portfolio: "portfolio",
  portfoliourl: "portfolio",
  school: "school",
  schoolname: "school",
  university: "school",
  degree: "degree",
  degreelevel: "degree",
  discipline: "discipline",
  major: "discipline",
  fieldofstudy: "discipline",
  educationstartyear: "educationStartYear",
  educationendyear: "educationEndYear",
  streetaddress: "address",
  addressline1: "address",
  state: "region",
  province: "region",
  zipcode: "postalCode",
  zip: "postalCode",
};

function canonicalCandidateField(field: string): string {
  return CANDIDATE_FIELD_ALIASES[field.replace(/[^a-z0-9]/gi, "").toLowerCase()] ?? field;
}

export type ClaimedNotification = {
  id: string;
  userId: string;
  applicationId: string | null;
  toEmail: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
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

  sealJobDocument(userId: string, documentId: string, bytes: Uint8Array): Uint8Array {
    return encryptBinary(bytes, this.masterKey, `${userId}:${documentId}`);
  }

  sealJobExtractedText(text: string): string {
    return encryptSecret(text, this.masterKey);
  }

  unsealJobDocument(userId: string, documentId: string, bytes: Uint8Array): Uint8Array {
    return decryptBinary(bytes, this.masterKey, `${userId}:${documentId}`);
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
        preferredModel: users.preferredModel,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || !row.isActive) return null;
    return {
      userId: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
      preferredModel: row.preferredModel,
    };
  }

  /** Granular permissions a user holds. Admins need none — their role implies all. */
  async permissions(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(eq(userPermissions.userId, userId));
    return rows.map((row) => row.permission);
  }

  /** Whether `sessionId` has been shared with `userId`. */
  async isShared(sessionId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessionShares.id })
      .from(sessionShares)
      .where(and(eq(sessionShares.robotSessionId, sessionId), eq(sessionShares.userId, userId)))
      .limit(1);
    return Boolean(row);
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

  /** Lease one queued job with a compare-and-set update so concurrent runtimes cannot both win. */
  async claimJob(workerId: string, leaseMs = 5 * 60_000): Promise<ClaimedJobApplication | null> {
    const now = new Date();
    const [candidate] = await this.db
      .select({ id: jobApplications.id })
      .from(jobApplications)
      .where(or(
        eq(jobApplications.status, "queued"),
        and(eq(jobApplications.status, "running"), lt(jobApplications.claimExpiresAt, now)),
      ))
      .orderBy(asc(jobApplications.createdAt))
      .limit(1);
    if (!candidate) return null;

    const [claimed] = await this.db
      .update(jobApplications)
      .set({
        status: "running",
        claimedBy: workerId,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        startedAt: now,
        attempt: sql`${jobApplications.attempt} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(jobApplications.id, candidate.id),
        or(
          eq(jobApplications.status, "queued"),
          and(eq(jobApplications.status, "running"), lt(jobApplications.claimExpiresAt, now)),
        ),
      ))
      .returning({
        id: jobApplications.id,
        userId: jobApplications.userId,
        sourceUrl: jobApplications.sourceUrl,
        normalizedUrl: jobApplications.normalizedUrl,
        atsKind: jobApplications.atsKind,
        model: jobApplications.model,
        resumeDocumentId: jobApplications.resumeDocumentId,
        reapplyRequested: jobApplications.reapplyRequested,
        attempt: jobApplications.attempt,
      });
    if (!claimed) return null;
    await this.db.insert(jobApplicationEvents).values({ applicationId: claimed.id, type: "running", detail: "Application worker claimed the job" });
    return claimed;
  }

  async createJobSession(application: ClaimedJobApplication, model: string): Promise<string> {
    const now = new Date();
    const [row] = await this.db.insert(robotSessions).values({
      userId: application.userId,
      siteProfileId: null,
      jobApplicationId: application.id,
      kind: "job",
      status: "starting",
      title: `Job application · ${new URL(application.sourceUrl).hostname}`,
      model,
      lastUrl: application.sourceUrl,
    }).onConflictDoUpdate({
      target: robotSessions.jobApplicationId,
      set: {
        status: "starting",
        startedAt: now,
        endedAt: null,
        endedReason: null,
        lastActivityAt: now,
        title: `Job application · ${new URL(application.sourceUrl).hostname}`,
        model,
        lastUrl: application.sourceUrl,
        lastUserMessage: null,
      },
    }).returning({ id: robotSessions.id });
    return row!.id;
  }

  async candidatePlaceholders(userId: string, fields: string[]): Promise<Record<string, string>> {
    const [row] = await this.db.select({
      profileEncrypted: jobCandidateProfiles.profileEncrypted,
      applicationEmailEncrypted: jobCandidateProfiles.applicationEmailEncrypted,
      notificationEmailEncrypted: jobCandidateProfiles.notificationEmailEncrypted,
    })
      .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
    if (!row) return {};
    const profile = decryptStructured<Record<string, unknown>>(row.profileEncrypted, this.masterKey);
    const available: Record<string, string> = {};
    for (const field of fields) {
      const canonical = canonicalCandidateField(field);
      const derivedName = (canonical === "firstName" || canonical === "lastName") && typeof profile.fullName === "string" && profile.fullName.trim().length > 0;
      if (derivedName || canonical === "applicationEmail" || canonical === "notificationEmail" || Object.hasOwn(profile, canonical)) {
        available[field] = `{{BP_PROFILE:${canonical}}}`;
      }
    }
    return available;
  }

  async resolveProfilePlaceholder(userId: string, field: string): Promise<unknown> {
    const [row] = await this.db.select({
      profileEncrypted: jobCandidateProfiles.profileEncrypted,
      applicationEmailEncrypted: jobCandidateProfiles.applicationEmailEncrypted,
      notificationEmailEncrypted: jobCandidateProfiles.notificationEmailEncrypted,
    })
      .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
    if (!row) throw new Error("Candidate profile is not configured");
    if (field === "applicationEmail") return decryptSecret(row.applicationEmailEncrypted, this.masterKey);
    if (field === "notificationEmail") return decryptSecret(row.notificationEmailEncrypted, this.masterKey);
    const profile = decryptStructured<Record<string, unknown>>(row.profileEncrypted, this.masterKey);
    if (field === "firstName" || field === "lastName") {
      const parts = typeof profile.fullName === "string" ? profile.fullName.trim().split(/\s+/).filter(Boolean) : [];
      if (!parts.length) throw new Error("Candidate full name is not configured");
      return field === "firstName" ? parts[0] : parts.slice(1).join(" ");
    }
    if (!Object.hasOwn(profile, field)) throw new Error("Candidate field is not configured");
    return profile[field];
  }

  async jobConfigurationIssues(userId: string, applicationId: string): Promise<string[]> {
    const [[profile], [application], [consent]] = await Promise.all([
      this.db.select({ profileEncrypted: jobCandidateProfiles.profileEncrypted }).from(jobCandidateProfiles)
        .where(eq(jobCandidateProfiles.userId, userId)).limit(1),
      this.db.select({ resumeDocumentId: jobApplications.resumeDocumentId }).from(jobApplications)
        .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId))).limit(1),
      this.db.select({ id: jobConsents.id }).from(jobConsents).where(and(
        eq(jobConsents.userId, userId),
        eq(jobConsents.version, "2026-08-04"),
        sql`${jobConsents.revokedAt} is null`,
      )).limit(1),
    ]);
    const issues: string[] = [];
    if (!profile) {
      issues.push("Complete the candidate profile before retrying");
    } else {
      const candidate = decryptStructured<Record<string, unknown>>(profile.profileEncrypted, this.masterKey);
      const hasFullName = typeof candidate.fullName === "string" && candidate.fullName.trim().length > 0;
      const hasPhone = typeof candidate.phone === "string" && candidate.phone.trim().length > 0;
      const hasCity = typeof candidate.city === "string" && candidate.city.trim().length > 0;
      const hasCountry = typeof candidate.country === "string" && candidate.country.trim().length > 0;
      if (!hasFullName || !hasPhone || !hasCity || !hasCountry) issues.push("Complete the candidate profile with full name, phone, current city, and country before retrying");
    }
    if (!consent) issues.push("Accept the current automatic-application consent before retrying");
    if (!application?.resumeDocumentId) issues.push("Select a résumé before retrying");
    else {
      const [resume] = await this.db.select({ id: jobDocuments.id }).from(jobDocuments).where(and(
        eq(jobDocuments.id, application.resumeDocumentId),
        eq(jobDocuments.userId, userId),
        eq(jobDocuments.kind, "resume"),
      )).limit(1);
      if (!resume) issues.push("The selected résumé is unavailable; choose another version");
    }
    return issues;
  }

  async savedJobAnswer(
    userId: string,
    question: { label: string; answerType: JobAnswerType; options: string[] },
  ): Promise<unknown | null> {
    const candidates = jobAnswerMatchCandidates(question.label, question.answerType, question.options);
    const [row] = await this.db.select({ answerEncrypted: jobAnswers.answerEncrypted })
      .from(jobAnswers)
      .where(and(
        eq(jobAnswers.userId, userId),
        or(...candidates.map((candidate) => and(
          eq(jobAnswers.questionKey, candidate.questionKey),
          eq(jobAnswers.optionSignature, candidate.optionSignature),
        ))),
      ))
      .limit(1);
    if (!row) return null;
    const answer = decryptStructured(row.answerEncrypted, this.masterKey);
    return validateJobAnswer(question.answerType, question.options, answer) ? answer : null;
  }

  async coverLetterContext(userId: string, applicationId: string): Promise<{
    profile: Record<string, unknown>;
    resumeText: string;
  }> {
    const [application] = await this.db.select({ resumeDocumentId: jobApplications.resumeDocumentId })
      .from(jobApplications)
      .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId)))
      .limit(1);
    if (!application?.resumeDocumentId) throw new Error("The application has no selected résumé");
    const [[profile], [resume]] = await Promise.all([
      this.db.select({ profileEncrypted: jobCandidateProfiles.profileEncrypted })
        .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1),
      this.db.select({ extractedTextEncrypted: jobDocuments.extractedTextEncrypted })
        .from(jobDocuments).where(and(
          eq(jobDocuments.id, application.resumeDocumentId),
          eq(jobDocuments.userId, userId),
          eq(jobDocuments.kind, "resume"),
        )).limit(1),
    ]);
    if (!profile) throw new Error("Candidate profile is not configured");
    if (!resume?.extractedTextEncrypted) throw new Error("The selected résumé has no extracted text");
    const full = decryptStructured<Record<string, unknown>>(profile.profileEncrypted, this.masterKey);
    const allowed = ["fullName", "city", "region", "country", "summary", "employmentHistory", "education", "skills", "projects", "certifications", "linkedin", "github", "portfolio"];
    const selected = Object.fromEntries(
      allowed.filter((field) => Object.hasOwn(full, field)).map((field) => [field, full[field]]),
    );
    return {
      profile: selected,
      resumeText: decryptSecret(resume.extractedTextEncrypted, this.masterKey),
    };
  }

  async applicationDocument(
    userId: string,
    applicationId: string,
    kind: "resume" | "cover_letter",
  ): Promise<StagedJobDocument | null> {
    const [application] = await this.db.select({
      resumeDocumentId: jobApplications.resumeDocumentId,
      coverLetterDocumentId: jobApplications.coverLetterDocumentId,
    }).from(jobApplications)
      .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId)))
      .limit(1);
    const documentId = kind === "resume" ? application?.resumeDocumentId : application?.coverLetterDocumentId;
    if (!documentId) return null;
    const [document] = await this.db.select({
      id: jobDocuments.id,
      filename: jobDocuments.filename,
      objectKey: jobDocuments.objectKey,
      contentType: jobDocuments.contentType,
      encryptionAad: jobDocuments.encryptionAad,
    }).from(jobDocuments).where(and(
      eq(jobDocuments.id, documentId),
      eq(jobDocuments.userId, userId),
      eq(jobDocuments.kind, kind),
    )).limit(1);
    return document ?? null;
  }

  async saveGeneratedCoverLetter(input: {
    id: string;
    userId: string;
    applicationId: string;
    filename: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    encryptionAad: string;
    extractedTextEncrypted: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: jobApplications.id }).from(jobApplications)
        .where(and(eq(jobApplications.id, input.applicationId), eq(jobApplications.userId, input.userId))).limit(1);
      if (!owned) throw new Error("Application is unavailable");
      await tx.insert(jobDocuments).values({
        id: input.id,
        userId: input.userId,
        kind: "cover_letter",
        name: "Generated cover letter",
        filename: input.filename,
        objectKey: input.objectKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        encryptionAad: input.encryptionAad,
        extractedTextEncrypted: input.extractedTextEncrypted,
        sourceApplicationId: input.applicationId,
      });
      await tx.update(jobApplications).set({ coverLetterDocumentId: input.id, updatedAt: new Date() })
        .where(and(eq(jobApplications.id, input.applicationId), eq(jobApplications.userId, input.userId)));
      await tx.insert(jobApplicationEvents).values({
        applicationId: input.applicationId,
        type: "cover_letter_generated",
        detail: "Encrypted cover letter generated and staged",
      });
    });
  }

  async portalAccountPlaceholders(userId: string, portalKey: string, portalOrigin: string): Promise<{ username: string; password: string }> {
    let [row] = await this.db.select().from(jobPortalAccounts)
      .where(and(eq(jobPortalAccounts.userId, userId), eq(jobPortalAccounts.portalKey, portalKey))).limit(1);
    if (!row) {
      const [profile] = await this.db.select({ applicationEmailEncrypted: jobCandidateProfiles.applicationEmailEncrypted })
        .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
      if (!profile) throw new Error("Candidate profile is not configured");
      [row] = await this.db.insert(jobPortalAccounts).values({
        userId,
        portalKey,
        portalLabel: new URL(portalOrigin).hostname,
        portalOrigin,
        username: decryptSecret(profile.applicationEmailEncrypted, this.masterKey),
        passwordEncrypted: encryptSecret(generatePortalPassword(), this.masterKey),
        status: "pending",
      }).returning();
    }
    return { username: `{{BP_SECRET:${row!.id}_username}}`, password: `{{BP_SECRET:${row!.id}_password}}` };
  }

  async markPortalAccountActive(userId: string, portalKey: string, verified = false): Promise<void> {
    await this.db.update(jobPortalAccounts).set({
      status: "active",
      verificationStatus: verified ? "verified" : "confirmed",
      ...(verified ? { verifiedAt: new Date() } : {}),
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(jobPortalAccounts.userId, userId), eq(jobPortalAccounts.portalKey, portalKey)));
  }

  async resetPortalAccount(userId: string, portalKey: string): Promise<{ username: string; password: string }> {
    const [row] = await this.db.update(jobPortalAccounts).set({
      passwordEncrypted: encryptSecret(generatePortalPassword(), this.masterKey),
      status: "pending",
      verificationStatus: "reset_pending",
      verifiedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(jobPortalAccounts.userId, userId), eq(jobPortalAccounts.portalKey, portalKey)))
      .returning({ id: jobPortalAccounts.id });
    if (!row) throw new Error("Portal account is unavailable");
    return {
      username: `{{BP_SECRET:${row.id}_username}}`,
      password: `{{BP_SECRET:${row.id}_password}}`,
    };
  }

  async resolvePortalPlaceholder(userId: string, token: string): Promise<string> {
    const match = /^([0-9a-f-]{36})_(username|password)$/i.exec(token);
    if (!match) throw new Error("Unknown credential placeholder");
    const [row] = await this.db.select().from(jobPortalAccounts)
      .where(and(eq(jobPortalAccounts.id, match[1]!), eq(jobPortalAccounts.userId, userId))).limit(1);
    if (!row) throw new Error("Portal credential is unavailable");
    return match[2] === "username" ? row.username : decryptSecret(row.passwordEncrypted, this.masterKey);
  }

  async discoverJobIdentity(userId: string, applicationId: string, identity: {
    portalKey: string;
    externalJobId: string;
    company?: string;
    roleTitle?: string;
    location?: string;
  }): Promise<{ duplicateOf?: string }> {
    const [application] = await this.db.select({ reapplyRequested: jobApplications.reapplyRequested })
      .from(jobApplications)
      .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId)))
      .limit(1);
    if (!application) throw new Error("Application is unavailable");
    const [duplicate] = await this.db.select({ id: jobApplications.id, status: jobApplications.status })
      .from(jobApplications).where(and(
        eq(jobApplications.userId, userId),
        ne(jobApplications.id, applicationId),
        eq(jobApplications.portalKey, identity.portalKey),
        eq(jobApplications.externalJobId, identity.externalJobId),
      )).orderBy(asc(jobApplications.createdAt)).limit(1);
    const duplicateOf = duplicate && !application.reapplyRequested ? duplicate.id : undefined;
    await this.db.update(jobApplications).set({
      portalKey: identity.portalKey,
      externalJobId: identity.externalJobId,
      company: identity.company?.slice(0, 300),
      roleTitle: identity.roleTitle?.slice(0, 300),
      location: identity.location?.slice(0, 300),
      ...(duplicateOf ? {
        status: "not_applied" as const,
        duplicateOfApplicationId: duplicateOf,
        statusDetail: `Linked to existing ${duplicate!.status} application after portal discovery`,
        finishedAt: new Date(),
        claimedBy: null,
        claimExpiresAt: null,
      } : {}),
      updatedAt: new Date(),
    }).where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId)));
    if (duplicateOf) {
      await this.enqueueJobNotification(
        userId,
        applicationId,
        "duplicate-after-launch",
        "Duplicate application detected after portal discovery",
      );
    }
    return duplicateOf ? { duplicateOf } : {};
  }

  async applicationEmail(userId: string): Promise<string> {
    const [profile] = await this.db.select({ applicationEmailEncrypted: jobCandidateProfiles.applicationEmailEncrypted })
      .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
    if (!profile) throw new Error("Candidate profile is not configured");
    return decryptSecret(profile.applicationEmailEncrypted, this.masterKey);
  }

  async recordGmailUse(userId: string, error?: Error): Promise<void> {
    const message = error?.message.slice(0, 300).replace(/\S+@\S+/g, "[email]") ?? null;
    const revoked = Boolean(error && /(?:401|invalid_grant|revoked)/i.test(error.message));
    await this.db.update(jobConnections).set({
      state: revoked ? "revoked" : error ? "error" : "active",
      lastError: message,
      lastUsedAt: new Date(),
      ...(revoked ? { revokedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(jobConnections.userId, userId), eq(jobConnections.kind, "gmail")));
  }

  async saveJobAnswer(userId: string, applicationId: string, question: { label: string; answerType: JobAnswerType; options: string[] }, value: unknown): Promise<void> {
    if (!validateJobAnswer(question.answerType, question.options, value)) {
      throw new Error("The answer does not match the exact portal question options");
    }
    const optionSignature = jobOptionSignature(question.answerType, question.options);
    const questionKey = jobAnswerMatchKey(question.label, question.answerType, question.options);
    await this.db.transaction(async (tx) => {
      await tx.insert(jobAnswers).values({
        userId, questionKey, questionLabel: question.label, answerType: question.answerType,
        optionSignature, answerEncrypted: encryptStructured(value, this.masterKey), category: "custom",
      }).onConflictDoUpdate({
        target: [jobAnswers.userId, jobAnswers.questionKey, jobAnswers.optionSignature],
        set: { answerEncrypted: encryptStructured(value, this.masterKey), updatedAt: new Date() },
      });
      await tx.update(jobQuestions).set({ status: "answered", answeredAt: new Date() })
        .where(and(eq(jobQuestions.applicationId, applicationId), eq(jobQuestions.questionKey, questionKey)));
      await tx.update(jobApplications).set({ status: "running", attentionKind: null, statusDetail: "Application resumed with the saved answer", updatedAt: new Date() })
        .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId), eq(jobApplications.status, "needs_attention")));
    });
  }

  async recordJobQuestion(userId: string, event: Extract<RobotEvent, { type: "job_question" }>): Promise<void> {
    const options = event.options ?? [];
    const questionKey = jobAnswerMatchKey(event.question, event.answerType, options);
    const optionSignature = jobOptionSignature(event.answerType, options);
    await this.db.insert(jobQuestions).values({
      applicationId: event.applicationId, userId, requestId: event.requestId,
      questionKey, questionLabel: event.question, answerType: event.answerType,
      options, optionSignature,
    }).onConflictDoNothing();
    const rows = await this.db.update(jobApplications).set({ status: "needs_attention", attentionKind: "needs_answer", statusDetail: "A new application question needs an answer", updatedAt: new Date() })
      .where(and(eq(jobApplications.id, event.applicationId), eq(jobApplications.userId, userId), inArray(jobApplications.status, ["running", "needs_attention"])))
      .returning({ id: jobApplications.id });
    if (rows.length) await this.enqueueJobNotification(userId, event.applicationId, "needs-answer", "A job application needs an answer");
  }

  async recordTakeover(userId: string, event: Extract<RobotEvent, { type: "manual_takeover" }>): Promise<void> {
    const rows = await this.db.update(jobApplications).set({
      status: event.active ? "needs_attention" : "running",
      attentionKind: event.active ? "needs_takeover" : null,
      takeoverRequestId: event.active ? event.requestId : null,
      statusDetail: event.active ? event.reason.slice(0, 500) : "Application resumed after manual takeover",
      updatedAt: new Date(),
    }).where(and(eq(jobApplications.id, event.applicationId), eq(jobApplications.userId, userId), inArray(jobApplications.status, ["running", "needs_attention"])))
      .returning({ id: jobApplications.id });
    if (event.active && rows.length) await this.enqueueJobNotification(userId, event.applicationId, "needs-takeover", "A job application needs manual takeover");
  }

  async prepareJobSubmission(userId: string, applicationId: string, inventory: ApplicationInventory): Promise<{ ok: boolean; reasons?: string[] }> {
    const validation = validateApplicationInventory(inventory);
    const [[consent], [application], [pending]] = await Promise.all([
      this.db.select({ id: jobConsents.id }).from(jobConsents)
        .where(and(eq(jobConsents.userId, userId), eq(jobConsents.version, "2026-08-04"), sql`${jobConsents.revokedAt} is null`)).limit(1),
      this.db.select({
        resumeDocumentId: jobApplications.resumeDocumentId,
        coverLetterDocumentId: jobApplications.coverLetterDocumentId,
        status: jobApplications.status,
      }).from(jobApplications).where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId))).limit(1),
      this.db.select({ value: count() }).from(jobQuestions).where(and(
        eq(jobQuestions.applicationId, applicationId),
        eq(jobQuestions.userId, userId),
        eq(jobQuestions.status, "pending"),
      )),
    ]);
    const reasons = validation.ok ? [] : [...validation.reasons];
    if (!consent) reasons.push("Routine application consent is missing");
    if (application?.status !== "running") reasons.push("The application is no longer eligible for submission");
    if (!application?.resumeDocumentId) reasons.push("The selected résumé record is missing");
    if (inventory.coverLetterRequired && !application?.coverLetterDocumentId) reasons.push("The generated cover letter record is missing");
    if (Number(pending?.value ?? 0) > 0) reasons.push("Saved application questions remain unresolved");
    const ok = reasons.length === 0;
    await this.db.update(jobApplications).set({ submissionInventory: inventory, updatedAt: new Date() })
      .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId)));
    return ok ? { ok: true } : { ok: false, reasons };
  }

  async recordJobSubmission(userId: string, applicationId: string, evidence: SubmissionEvidence): Promise<{ ok: boolean; reason?: string }> {
    if (!hasSubmissionEvidence(evidence)) return { ok: false, reason: "Confirmation evidence is required" };
    const now = new Date();
    const rows = await this.db.update(jobApplications).set({
      status: "applied", statusDetail: "Submission confirmed", submittedAt: now, finishedAt: now,
      confirmationText: evidence.confirmationText?.slice(0, 2000), confirmationUrl: evidence.confirmationUrl,
      confirmationScreenshotKey: evidence.screenshotKey, confirmationReference: evidence.referenceId,
      claimExpiresAt: null, updatedAt: now,
    }).where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId), eq(jobApplications.status, "running")))
      .returning({ id: jobApplications.id });
    if (!rows.length) return { ok: false, reason: "Application is unavailable" };
    await this.enqueueJobNotification(userId, applicationId, "submitted", "Application submitted");
    return { ok: true };
  }

  async failJob(userId: string, applicationId: string, reason: string): Promise<void> {
    const safeReason = reason.slice(0, 1000).replace(/(?:password|token|code|answer)\s*[:=]\s*\S+/gi, "[redacted]");
    const rows = await this.db.update(jobApplications).set({ status: "failed", failureReason: safeReason, statusDetail: safeReason, finishedAt: new Date(), claimExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId), inArray(jobApplications.status, ["queued", "running", "needs_attention"])))
      .returning({ id: jobApplications.id });
    if (rows.length) await this.enqueueJobNotification(userId, applicationId, "failed", "Application failed");
  }

  async pauseJob(userId: string, applicationId: string, reason: string): Promise<void> {
    const rows = await this.db.update(jobApplications).set({
      status: "needs_attention", attentionKind: "interrupted", statusDetail: reason.slice(0, 500),
      claimExpiresAt: null, claimedBy: null, updatedAt: new Date(),
    }).where(and(
      eq(jobApplications.id, applicationId),
      eq(jobApplications.userId, userId),
      notInArray(jobApplications.status, ["applied", "failed", "cancelled", "not_applied"]),
    )).returning({ id: jobApplications.id });
    if (rows.length) await this.enqueueJobNotification(userId, applicationId, "needs-takeover", "Application needs attention");
  }

  async releaseJob(userId: string, applicationId: string): Promise<void> {
    await this.db.update(jobApplications).set({
      status: "queued", claimedBy: null, claimExpiresAt: null, startedAt: null, updatedAt: new Date(),
    }).where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, userId), eq(jobApplications.status, "running")));
  }

  async renewJobLease(userId: string, applicationId: string, leaseMs = 5 * 60_000): Promise<void> {
    await this.db.update(jobApplications).set({
      claimExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    }).where(and(
      eq(jobApplications.id, applicationId),
      eq(jobApplications.userId, userId),
      eq(jobApplications.status, "running"),
    ));
  }

  /** A restart never blindly retries a browser that may already have submitted a form. */
  async recoverInterruptedJobs(): Promise<number> {
    const rows = await this.db.update(jobApplications).set({
      status: "needs_attention", attentionKind: "runtime_restart",
      statusDetail: "The runtime restarted during this application. Review before retrying.",
      claimedBy: null, claimExpiresAt: null, updatedAt: new Date(),
    }).where(eq(jobApplications.status, "running")).returning({ id: jobApplications.id });
    return rows.length;
  }

  async gmailCredentials(userId: string): Promise<{ accountEmail: string; refreshToken: string } | null> {
    const [row] = await this.db.select().from(jobConnections).where(and(
      eq(jobConnections.userId, userId), eq(jobConnections.kind, "gmail"), eq(jobConnections.state, "active"),
    )).limit(1);
    if (!row) return null;
    return { accountEmail: row.accountEmail, refreshToken: decryptSecret(row.refreshTokenEncrypted, this.masterKey) };
  }

  async claimNotification(): Promise<ClaimedNotification | null> {
    const now = new Date();
    const [candidate] = await this.db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(inArray(notificationOutbox.status, ["pending", "failed"]), lt(notificationOutbox.nextAttemptAt, new Date(now.getTime() + 1))))
      .orderBy(asc(notificationOutbox.nextAttemptAt)).limit(1);
    if (!candidate) return null;
    const [claimed] = await this.db.update(notificationOutbox).set({ status: "sending", attempts: sql`${notificationOutbox.attempts} + 1` })
      .where(and(eq(notificationOutbox.id, candidate.id), inArray(notificationOutbox.status, ["pending", "failed"])))
      .returning({ id: notificationOutbox.id, userId: notificationOutbox.userId, applicationId: notificationOutbox.applicationId,
        toEmail: notificationOutbox.toEmail, template: notificationOutbox.template, payload: notificationOutbox.payload, attempts: notificationOutbox.attempts });
    return claimed ? { ...claimed, payload: claimed.payload as Record<string, unknown> } : null;
  }

  async finishNotification(notification: ClaimedNotification, error?: Error): Promise<void> {
    await this.db.update(notificationOutbox).set(error ? {
      status: "failed",
      nextAttemptAt: notificationRetryAt(notification.attempts),
      lastError: error.message.slice(0, 300).replace(/\S+@\S+/g, "[email]"),
    } : { status: "sent", sentAt: new Date(), lastError: null })
      .where(eq(notificationOutbox.id, notification.id));
  }

  async recordNotificationStatus(
    applicationId: string | null,
    status: "pending" | "sending" | "sent" | "failed",
  ): Promise<void> {
    if (!applicationId) return;
    const [session] = await this.db.select({ id: robotSessions.id }).from(robotSessions)
      .where(eq(robotSessions.jobApplicationId, applicationId))
      .orderBy(desc(robotSessions.startedAt)).limit(1);
    if (!session) return;
    await this.appendEvent(session.id, { type: "notification_status", applicationId, status });
  }

  private async enqueueJobNotification(userId: string, applicationId: string, template: string, message: string): Promise<void> {
    const [profile] = await this.db.select({ notificationEmailEncrypted: jobCandidateProfiles.notificationEmailEncrypted })
      .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
    if (!profile) return;
    const inserted = await this.db.insert(notificationOutbox).values({
      userId, applicationId, dedupeKey: `${applicationId}:${template}`,
      toEmail: decryptSecret(profile.notificationEmailEncrypted, this.masterKey),
      template, payload: { applicationId, message },
    }).onConflictDoNothing().returning({ id: notificationOutbox.id });
    if (inserted.length) await this.recordNotificationStatus(applicationId, "pending");
  }
}
