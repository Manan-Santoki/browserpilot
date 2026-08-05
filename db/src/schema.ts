import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRole = pgEnum("user_role", ["ADMIN", "USER"]);

export const loginStrategy = pgEnum("login_strategy", [
  "cookie_mint",
  "persistent_profile",
  "manual_login",
]);

/** How far a person has got with signing in to a target site themselves. */
export const linkState = pgEnum("link_state", ["none", "linked", "expired"]);

/**
 * An agent session drives a site; a login session is the person driving it
 * themselves to sign in. Both are real browsers with a live preview, so they
 * share the session machinery — a login session simply has no agent attached.
 */
export const sessionKind = pgEnum("session_kind", ["agent", "login", "job"]);

export const jobApplicationStatus = pgEnum("job_application_status", [
  "queued",
  "running",
  "needs_attention",
  "applied",
  "not_applied",
  "failed",
  "cancelled",
]);

export const jobDocumentKind = pgEnum("job_document_kind", ["resume", "cover_letter"]);

export const jobConnectionKind = pgEnum("job_connection_kind", ["gmail"]);

export const jobConnectionState = pgEnum("job_connection_state", [
  "active",
  "revoked",
  "error",
]);

export const jobPortalAccountStatus = pgEnum("job_portal_account_status", [
  "pending",
  "active",
  "reset_required",
  "disabled",
]);

export const jobQuestionType = pgEnum("job_question_type", [
  "text",
  "boolean",
  "number",
  "date",
  "single_choice",
  "multi_choice",
]);

export const jobQuestionStatus = pgEnum("job_question_status", ["pending", "answered", "dismissed"]);

export const notificationStatus = pgEnum("notification_status", [
  "pending",
  "sending",
  "sent",
  "failed",
]);

export const sessionStatus = pgEnum("session_status", [
  "starting",
  "idle",
  "working",
  "awaiting_approval",
  "stopped",
  "failed",
  "interrupted",
]);

/** People who can sign in to the console. Created by invite only. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: userRole("role").notNull().default("USER"),
    isActive: boolean("is_active").notNull().default(true),
    preferredLanguage: text("preferred_language").notNull().default("en"),
    /** The person's usual model. Beats the deployment default, loses to a per-session pick. */
    preferredModel: text("preferred_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/**
 * Granular permissions that refine the coarse `USER` role. `ADMIN` implies
 * every permission, so a person with the role needs no rows here; a `USER`
 * does nothing beyond what these rows grant.
 */
export const userPermissions = pgTable(
  "user_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_permissions_user_permission_key").on(t.userId, t.permission),
    index("user_permissions_user_id_idx").on(t.userId),
  ],
);

/**
 * Who a session's owner has granted read-only access to. A share lets the
 * grantee watch a session and nothing more — no typing, no approvals.
 */
export const sessionShares = pgTable(
  "session_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    robotSessionId: uuid("robot_session_id")
      .notNull()
      .references(() => robotSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedById: uuid("granted_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("session_shares_session_user_key").on(t.robotSessionId, t.userId),
    index("session_shares_user_id_idx").on(t.userId),
  ],
);

/** Console login sessions. The cookie carries the id; the secret is stored hashed. */
export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("web_sessions_token_hash_key").on(t.tokenHash),
    index("web_sessions_user_id_idx").on(t.userId),
  ],
);

/** The only route to a new account. */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    role: userRole("role").notNull().default("USER"),
    tokenHash: text("token_hash").notNull(),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invites_token_hash_key").on(t.tokenHash)],
);

/**
 * A target website the robot can drive. Registered from the console, which is
 * why there are no per-target environment variables.
 *
 * `secretEncrypted` holds the site's cookie-mint signing secret, encrypted with
 * the master key (AES-256-GCM) so the database alone never yields it.
 */
export const siteProfiles = pgTable(
  "site_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    loginStrategy: loginStrategy("login_strategy").notNull().default("cookie_mint"),
    /** Session cookie name the target application reads. */
    cookieName: text("cookie_name").notNull().default("session"),
    secretEncrypted: text("secret_encrypted"),
    /**
     * Marks a page as "you are signed out". A stored login eventually expires,
     * and the only signal the target gives is bouncing back to its login page.
     * Substring or regex; when absent a set of common defaults is used.
     */
    loggedOutPattern: text("logged_out_pattern"),
    systemPromptNotes: text("system_prompt_notes"),
    destructivePatterns: jsonb("destructive_patterns").$type<string[]>(),
    isActive: boolean("is_active").notNull().default(true),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_profiles_name_key").on(t.name)],
);

/**
 * Which identity a given BrowserPilot user assumes on a given target site.
 *
 * BrowserPilot's own user id means nothing to the target application, so
 * cookie-mint needs the account details the target expects. Keeping this per
 * (user, site) rather than on the site itself preserves attribution: the
 * target's own audit trail shows the real person, not a shared robot account.
 */
export const siteAccounts = pgTable(
  "site_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteProfileId: uuid("site_profile_id")
      .notNull()
      .references(() => siteProfiles.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The identity to mint, for cookie_mint sites only. A site the person signs
     * in to themselves has no minted identity — the target already knows who
     * they are from the session its own login handed back.
     */
    targetUserId: text("target_user_id"),
    targetEmail: text("target_email"),
    targetName: text("target_name"),
    targetRole: text("target_role").default("user"),
    /** Whether a browser profile has been captured for this person and site. */
    linkState: linkState("link_state").notNull().default("none"),
    /**
     * The cookies that sign-in produced, sealed.
     *
     * The profile directory holds everything else, but Chromium keeps session
     * cookies — the ones with no expiry, which a great many logins issue — in
     * memory and discards them on close. They would be lost between sessions
     * without being captured here.
     */
    cookiesEncrypted: text("cookies_encrypted"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    /** Last time a finished session wrote its cookies back to the profile. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_accounts_site_user_key").on(t.siteProfileId, t.userId)],
);

/** One robot browser session. Written by the runtime, read by the console. */
export const robotSessions = pgTable(
  "robot_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    siteProfileId: uuid("site_profile_id").references(() => siteProfiles.id, {
      onDelete: "set null",
    }),
    kind: sessionKind("kind").notNull().default("agent"),
    status: sessionStatus("status").notNull().default("starting"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title"),
    /** Atomically incremented when a durable transcript event is appended. */
    eventSeq: integer("event_seq").notNull().default(0),
    /** The finished run this one continues. Kept as lineage rather than rewriting history. */
    resumedFromSessionId: uuid("resumed_from_session_id").references(
      (): AnyPgColumn => robotSessions.id,
      { onDelete: "set null" },
    ),
    /** Fixed for a run, and reused by a continuation unless the user chooses another. */
    model: text("model"),
    /** Best-effort browser checkpoint. A continuation still verifies the page before acting. */
    lastUrl: text("last_url"),
    /** Last explicit request, used to identify unfinished work without replaying approvals. */
    lastUserMessage: text("last_user_message"),
    /** Present only for isolated job-application sessions. */
    jobApplicationId: uuid("job_application_id").references(
      (): AnyPgColumn => jobApplications.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    index("robot_sessions_user_id_idx").on(t.userId),
    index("robot_sessions_status_idx").on(t.status),
    uniqueIndex("robot_sessions_resumed_from_key").on(t.resumedFromSessionId),
    uniqueIndex("robot_sessions_job_application_key").on(t.jobApplicationId),
  ],
);

/** Durable transcript, so a reconnecting client can replay what it missed. */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    robotSessionId: uuid("robot_session_id")
      .notNull()
      .references(() => robotSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("session_events_session_seq_key").on(t.robotSessionId, t.seq)],
);

/** A paired phone. The mobile app exchanges a QR code for one of these. */
export const remoteDevices = pgTable(
  "remote_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("remote_devices_token_hash_key").on(t.tokenHash),
    index("remote_devices_user_id_idx").on(t.userId),
  ],
);

/** One-time codes behind the pairing QR. */
export const pairingCodes = pgTable(
  "pairing_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pairing_codes_code_hash_key").on(t.codeHash)],
);

/** Admin-editable runtime settings — session caps, timeouts, default model. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Candidate data is deliberately one row per owner. The JSON value is sealed
 * as a single authenticated blob so names, phone numbers and addresses are
 * never readable from a database dump and cannot accidentally become columns
 * in an administrator-facing query.
 */
export const jobCandidateProfiles = pgTable("job_candidate_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  profileEncrypted: text("profile_encrypted").notNull(),
  applicationEmailEncrypted: text("application_email_encrypted").notNull(),
  notificationEmailEncrypted: text("notification_email_encrypted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Résumés and generated cover letters live in object storage, not the DB. */
export const jobDocuments = pgTable(
  "job_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: jobDocumentKind("kind").notNull(),
    name: text("name").notNull(),
    filename: text("filename").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Object bytes are an authenticated binary envelope, never plaintext. */
    encryptionAad: text("encryption_aad").notNull(),
    extractedTextEncrypted: text("extracted_text_encrypted"),
    isDefault: boolean("is_default").notNull().default(false),
    sourceApplicationId: uuid("source_application_id").references(
      (): AnyPgColumn => jobApplications.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_documents_user_kind_idx").on(t.userId, t.kind)],
);

/** Normalized question keys are searchable; the answers themselves are sealed. */
export const jobAnswers = pgTable(
  "job_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionKey: text("question_key").notNull(),
    questionLabel: text("question_label").notNull(),
    answerType: jobQuestionType("answer_type").notNull().default("text"),
    optionSignature: text("option_signature").notNull().default("text"),
    answerEncrypted: text("answer_encrypted").notNull(),
    category: text("category").notNull().default("custom"),
    isSensitive: boolean("is_sensitive").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_answers_user_question_key").on(t.userId, t.questionKey, t.optionSignature),
    index("job_answers_user_id_idx").on(t.userId),
  ],
);

/** Credentials created for an employer/ATS. Only hostname and username remain visible. */
export const jobPortalAccounts = pgTable(
  "job_portal_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    portalKey: text("portal_key").notNull(),
    portalLabel: text("portal_label").notNull(),
    portalOrigin: text("portal_origin").notNull(),
    username: text("username").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    status: jobPortalAccountStatus("status").notNull().default("pending"),
    verificationStatus: text("verification_status").notNull().default("unverified"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_portal_accounts_user_portal_key").on(t.userId, t.portalKey),
    index("job_portal_accounts_user_id_idx").on(t.userId),
  ],
);

export const jobBatches = pgTable(
  "job_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    resumeDocumentId: uuid("resume_document_id").references(() => jobDocuments.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_batches_user_id_idx").on(t.userId)],
);

export const jobApplications = pgTable(
  "job_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => jobBatches.id, { onDelete: "set null" }),
    resumeDocumentId: uuid("resume_document_id").references(() => jobDocuments.id, {
      onDelete: "set null",
    }),
    coverLetterDocumentId: uuid("cover_letter_document_id").references(() => jobDocuments.id, {
      onDelete: "set null",
    }),
    sourceUrl: text("source_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    company: text("company"),
    roleTitle: text("role_title"),
    atsKind: text("ats_kind").notNull().default("generic"),
    portalKey: text("portal_key"),
    externalJobId: text("external_job_id"),
    location: text("location"),
    status: jobApplicationStatus("status").notNull().default("queued"),
    statusDetail: text("status_detail"),
    attentionKind: text("attention_kind"),
    takeoverRequestId: text("takeover_request_id"),
    failureReason: text("failure_reason"),
    attempt: integer("attempt").notNull().default(0),
    reapplyRequested: boolean("reapply_requested").notNull().default(false),
    duplicateOfApplicationId: uuid("duplicate_of_application_id").references(
      (): AnyPgColumn => jobApplications.id,
      { onDelete: "set null" },
    ),
    claimedBy: text("claimed_by"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    submissionInventory: jsonb("submission_inventory"),
    model: text("model"),
    confirmationUrl: text("confirmation_url"),
    confirmationText: text("confirmation_text"),
    confirmationReference: text("confirmation_reference"),
    confirmationScreenshotKey: text("confirmation_screenshot_key"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("job_applications_user_status_idx").on(t.userId, t.status),
    index("job_applications_batch_id_idx").on(t.batchId),
    index("job_applications_claim_idx").on(t.status, t.claimExpiresAt),
    index("job_applications_portal_external_idx").on(t.userId, t.portalKey, t.externalJobId),
    uniqueIndex("job_applications_user_normalized_active_key")
      .on(t.userId, t.normalizedUrl)
      .where(sql`${t.status} in ('queued', 'running', 'needs_attention')`),
  ],
);

/** A browser pause with a typed answer card; values are sealed in job_answers after reply. */
export const jobQuestions = pgTable(
  "job_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => jobApplications.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    questionKey: text("question_key").notNull(),
    questionLabel: text("question_label").notNull(),
    answerType: jobQuestionType("answer_type").notNull(),
    options: jsonb("options").$type<string[]>(),
    optionSignature: text("option_signature").notNull(),
    status: jobQuestionStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [
    index("job_questions_user_status_idx").on(t.userId, t.status),
    uniqueIndex("job_questions_application_match_key").on(t.applicationId, t.questionKey, t.optionSignature),
    uniqueIndex("job_questions_request_key").on(t.applicationId, t.requestId),
  ],
);

/** Append-only, user-visible lifecycle without secret-bearing form values. */
export const jobApplicationEvents = pgTable(
  "job_application_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => jobApplications.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    detail: text("detail"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_application_events_application_idx").on(t.applicationId, t.createdAt)],
);

/** OAuth refresh tokens are encrypted; message bodies are never stored. */
export const jobConnections = pgTable(
  "job_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: jobConnectionKind("kind").notNull(),
    accountEmail: text("account_email").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    scope: text("scope").notNull(),
    state: jobConnectionState("state").notNull().default("active"),
    lastError: text("last_error"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("job_connections_user_kind_key").on(t.userId, t.kind)],
);

export const jobConsents = pgTable(
  "job_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("job_consents_user_version_key").on(t.userId, t.version)],
);

/** Transactional outbox: state changes commit before email delivery is attempted. */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => jobApplications.id, {
      onDelete: "cascade",
    }),
    dedupeKey: text("dedupe_key").notNull(),
    toEmail: text("to_email").notNull(),
    template: text("template").notNull(),
    payload: jsonb("payload").notNull(),
    status: notificationStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_outbox_dedupe_key").on(t.dedupeKey),
    index("notification_outbox_pending_idx").on(t.status, t.nextAttemptAt),
  ],
);

/** Who did what: logins, session starts and stops, approvals, admin actions. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_created_at_idx").on(t.createdAt)],
);
