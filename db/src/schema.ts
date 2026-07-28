import {
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
    /** The identifier the target site uses — typically its own user UUID. */
    targetUserId: text("target_user_id").notNull(),
    targetEmail: text("target_email").notNull(),
    targetName: text("target_name").notNull(),
    targetRole: text("target_role").notNull().default("user"),
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
    status: sessionStatus("status").notNull().default("starting"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title"),
  },
  (t) => [
    index("robot_sessions_user_id_idx").on(t.userId),
    index("robot_sessions_status_idx").on(t.status),
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
