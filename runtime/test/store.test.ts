import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@browserpilot/core";
import { createDatabase, robotSessions, siteAccounts, siteProfiles, users } from "@browserpilot/db";
import { Store } from "../src/store";
import { DEFAULT_SETTINGS } from "../src/settings";

const url =
  process.env.DATABASE_URL ?? "postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot";
const MASTER_KEY = "k".repeat(44);

const db = createDatabase(url, { max: 2 });
const store = new Store(url, MASTER_KEY);

const stamp = Date.now();
const email = `store-${stamp}@test.local`;
const siteName = `store-site-${stamp}`;

let userId: string;
let siteId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email, name: "Store Test", passwordHash: "x" })
    .returning();
  userId = user!.id;

  const [site] = await db
    .insert(siteProfiles)
    .values({
      name: siteName,
      baseUrl: "https://target.test",
      secretEncrypted: encryptSecret("the-site-signing-secret", MASTER_KEY),
      systemPromptNotes: "Notes for the agent.",
      destructivePatterns: ["delete", "void"],
    })
    .returning();
  siteId = site!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(siteProfiles).where(eq(siteProfiles.id, siteId));
});

describe("settings", () => {
  // What is stored is whatever an admin last saved in the console, so assert
  // the contract rather than the numbers. The defaulting itself is covered by
  // the parseSettings tests, which do not need a database.
  test("always returns a complete, usable policy", async () => {
    const settings = await store.settings();

    expect(Object.keys(settings).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(settings.perUserSessionLimit).toBeGreaterThanOrEqual(1);
    expect(settings.globalSessionLimit).toBeGreaterThanOrEqual(1);
    expect(settings.idleTimeoutMs).toBeGreaterThan(0);
    expect(settings.hardCapMs).toBeGreaterThan(settings.idleTimeoutMs);
    expect(settings.defaultModel.length).toBeGreaterThan(0);
  });
});

describe("site profiles", () => {
  test("loads a site and unseals its secret", async () => {
    const site = await store.site(siteId);
    expect(site?.baseUrl).toBe("https://target.test");
    expect(site?.secret).toBe("the-site-signing-secret");
    expect(site?.destructivePatterns).toEqual(["delete", "void"]);
  });

  test("an unknown site is null rather than an exception", async () => {
    expect(await store.site("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("a deactivated site is not returned", async () => {
    await db.update(siteProfiles).set({ isActive: false }).where(eq(siteProfiles.id, siteId));
    expect(await store.site(siteId)).toBeNull();
    await db.update(siteProfiles).set({ isActive: true }).where(eq(siteProfiles.id, siteId));
  });

  test("the wrong master key cannot unseal the secret", async () => {
    const wrong = new Store(url, "w".repeat(44));
    await expect(wrong.site(siteId)).rejects.toThrow();
  });
});

describe("owners", () => {
  test("resolves an active user", async () => {
    expect((await store.owner(userId))?.email).toBe(email);
  });

  test("a deactivated user cannot own a session", async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, userId));
    expect(await store.owner(userId)).toBeNull();
    await db.update(users).set({ isActive: true }).where(eq(users.id, userId));
  });
});

describe("site accounts", () => {
  test("returns null when the user has no identity on the site", async () => {
    expect(await store.siteAccount(userId, siteId)).toBeNull();
  });

  test("resolves the identity the robot should assume", async () => {
    await db.insert(siteAccounts).values({
      siteProfileId: siteId,
      userId,
      targetUserId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
      targetEmail: "person@target.test",
      targetName: "Person On Target",
      targetRole: "admin",
    });

    const account = await store.siteAccount(userId, siteId);
    expect(account).toEqual({
      targetUserId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
      targetEmail: "person@target.test",
      targetName: "Person On Target",
      targetRole: "admin",
      // A cookie_mint account needs no saved login of its own.
      linkState: "none",
      cookies: null,
    });
  });

  test("a user's identity on one site does not leak to another", async () => {
    const [otherSite] = await db
      .insert(siteProfiles)
      .values({ name: `other-site-${stamp}`, baseUrl: "https://other.test" })
      .returning();

    expect(await store.siteAccount(userId, otherSite!.id)).toBeNull();
    await db.delete(siteProfiles).where(eq(siteProfiles.id, otherSite!.id));
  });
});

describe("sessions", () => {
  test("creating a session persists it as starting and counts as live", async () => {
    const before = await store.liveSessionCount(userId);
    const id = await store.createSession({ userId, siteProfileId: siteId, title: "first" });

    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.status).toBe("starting");
    expect(row?.title).toBe("first");
    expect(await store.liveSessionCount(userId)).toBe(before + 1);
  });

  test("stopping a session records the reason and frees the slot", async () => {
    const id = await store.createSession({ userId, siteProfileId: siteId });
    const during = await store.liveSessionCount(userId);

    await store.setStatus(id, "stopped", "user requested");

    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.status).toBe("stopped");
    expect(row?.endedReason).toBe("user requested");
    expect(row?.endedAt).not.toBeNull();
    expect(await store.liveSessionCount(userId)).toBe(during - 1);
  });

  test("events append in order and can be replayed", async () => {
    const id = await store.createSession({ userId, siteProfileId: siteId });

    await store.appendEvent(id, { type: "agent_text", text: "one" });
    await store.appendEvent(id, { type: "agent_text", text: "two" });
    await store.appendEvent(id, { type: "session_status", status: "idle" });

    const events = await store.events(id);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.payload).toEqual({ type: "agent_text", text: "one" });

    const tail = await store.events(id, 2);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.payload.type).toBe("session_status");

    await store.setStatus(id, "stopped");
  });

  test("concurrent events receive unique contiguous sequence numbers", async () => {
    const id = await store.createSession({ userId, siteProfileId: siteId });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.appendEvent(id, { type: "agent_text", text: `event ${i}` }),
      ),
    );

    const events = await store.events(id);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(new Set(events.map((event) => event.payload.type))).toEqual(new Set(["agent_text"]));
    await store.setStatus(id, "stopped");
  });

  test("stores resume lineage and safe browser checkpoints", async () => {
    const sourceId = await store.createSession({
      userId,
      siteProfileId: siteId,
      title: "source",
      model: "saved-model",
    });
    await store.checkpointSession(sourceId, {
      lastUrl: "https://target.test/orders/42",
      lastUserMessage: "Finish order 42",
    });
    await store.setStatus(sourceId, "stopped");

    const resumedId = await store.createSession({
      userId,
      siteProfileId: siteId,
      title: "source",
      model: "saved-model",
      resumedFromSessionId: sourceId,
      lastUrl: "https://target.test/orders/42",
      lastUserMessage: "Finish order 42",
    });

    expect(await store.continuationFor(sourceId)).toBe(resumedId);
    expect(await store.resumableSession(sourceId)).toMatchObject({
      id: sourceId,
      status: "stopped",
      model: "saved-model",
      lastUrl: "https://target.test/orders/42",
      lastUserMessage: "Finish order 42",
    });
    await store.setStatus(resumedId, "stopped");
  });

  test("orphaned sessions are marked interrupted at boot", async () => {
    const id = await store.createSession({ userId, siteProfileId: siteId });
    const changed = await store.markOrphansInterrupted();
    expect(changed).toBeGreaterThan(0);

    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.status).toBe("interrupted");
    expect(row?.endedReason).toBe("runtime restarted");
    // And they stop counting against the caps.
    expect(await store.liveSessionCount(userId)).toBe(0);
  });
});
