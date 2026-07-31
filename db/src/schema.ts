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
export const sessionKind = pgEnum("session_kind", ["agent", "login"]);

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
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
  },
  (t) => [
    index("robot_sessions_user_id_idx").on(t.userId),
    index("robot_sessions_status_idx").on(t.status),
    uniqueIndex("robot_sessions_resumed_from_key").on(t.resumedFromSessionId),
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
