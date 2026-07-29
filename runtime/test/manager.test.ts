import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encryptSecret } from "@browserpilot/core";
import { createDatabase, robotSessions, siteAccounts, siteProfiles, users } from "@browserpilot/db";
import { SessionManager, SessionError, type ManagerDeps } from "../src/session/manager";
import { Store } from "../src/store";
import { createLocalStore } from "../src/storage/object-store";
import type { RobotEvent } from "../src/session/events";
import { withTestSettings } from "./support/settings";
import { DB_HEAVY_TIMEOUT_MS } from "./helpers";

const url =
  process.env.DATABASE_URL ?? "postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot";
const MASTER_KEY = "k".repeat(44);

const db = createDatabase(url, { max: 3 });
const store = withTestSettings(new Store(url, MASTER_KEY));

const stamp = Date.now();
let userId: string;
let otherUserId: string;
let siteId: string;
let siteNoSecretId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: `mgr-${stamp}@test.local`, name: "Manager Test", passwordHash: "x" })
    .returning();
  userId = user!.id;

  const [other] = await db
    .insert(users)
    .values({ email: `mgr-other-${stamp}@test.local`, name: "Other", passwordHash: "x" })
    .returning();
  otherUserId = other!.id;

  const [site] = await db
    .insert(siteProfiles)
    .values({
      name: `mgr-site-${stamp}`,
      baseUrl: "https://target.test",
      secretEncrypted: encryptSecret("site-secret", MASTER_KEY),
    })
    .returning();
  siteId = site!.id;

  const [noSecret] = await db
    .insert(siteProfiles)
    .values({ name: `mgr-nosecret-${stamp}`, baseUrl: "https://nosecret.test" })
    .returning();
  siteNoSecretId = noSecret!.id;

  for (const profileId of [siteId, siteNoSecretId]) {
    await db.insert(siteAccounts).values({
      siteProfileId: profileId,
      userId,
      targetUserId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
      targetEmail: "person@target.test",
      targetName: "Person",
      targetRole: "admin",
    });
  }
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherUserId));
  await db.delete(siteProfiles).where(eq(siteProfiles.id, siteId));
  await db.delete(siteProfiles).where(eq(siteProfiles.id, siteNoSecretId));
});

function makeDeps(overrides: Partial<ManagerDeps> = {}) {
  const launched: Array<{ targetUrl: string; user: Record<string, string> }> = [];
  const sent: string[] = [];
  const closed = { browser: 0, agent: 0, input: 0 };
  const linked = new Set<string>();
  const checkouts: string[] = [];
  const syncedBack: string[] = [];
  const dispatched: unknown[] = [];
  let landingUrl = "https://target.test/dashboard";
  let emit: ((e: RobotEvent) => void) | undefined;
  let clock = 1_000;

  const deps: ManagerDeps = {
    store,
    profiles: {
      path: (site, user) => `/tmp/bp-profiles/${site}/${user}`,
      exists: async (site, user) => linked.has(`${site}:${user}`),
      prepareForLogin: async (site, user) => {
        linked.add(`${site}:${user}`);
        return `/tmp/bp-profiles/${site}/${user}`;
      },
      checkout: async (site, user) => {
        if (!linked.has(`${site}:${user}`)) throw new Error("No saved login for this site");
        checkouts.push(`${site}:${user}`);
      },
      syncBack: async (site, user) => {
        syncedBack.push(`${site}:${user}`);
      },
      remove: async (site, user) => {
        linked.delete(`${site}:${user}`);
      },
    },
    objects: async () => createLocalStore("/tmp/bp-mgr-test-objects"),
    createInput: async () => ({
      dispatch: async (event) => {
        dispatched.push(event);
      },
      close: () => {
        closed.input++;
      },
    }),
    now: () => clock,
    launchBrowser: async (args) => {
      launched.push({ targetUrl: args.targetUrl, user: args.user as unknown as Record<string, string> });
      return {
        cdpEndpoint: "http://127.0.0.1:1",
        downloadsDir: args.downloadsDir,
        profileDir: args.profileDir ?? "/tmp/bp-fake-profile",
        page: { url: () => landingUrl } as never,
        context: {} as never,
        onDownload: () => {},
        close: async () => {
          closed.browser++;
        },
      };
    },
    startAgent: async (args) => {
      emit = args.onEvent;
      return {
        send: (t: string) => sent.push(t),
        approve: () => {},
        stop: async () => {
          closed.agent++;
        },
      };
    },
    startScreencast: async () => ({ stop: async () => {} }),
    ...overrides,
  };

  return {
    deps,
    launched,
    sent,
    closed,
    linked,
    checkouts,
    syncedBack,
    dispatched,
    landOn: (url: string) => (landingUrl = url),
    fire: (e: RobotEvent) => emit!(e),
    tick: (ms: number) => (clock += ms),
  };
}

const config = {
  downloadsRoot: "/tmp/bp-mgr-test",
  scratchRoot: "/tmp/bp-mgr-test-scratch",
  env: {},
};

async function cleanupSessions() {
  await db.delete(robotSessions).where(eq(robotSessions.userId, userId));
}

describe("starting a session", () => {
  test("resolves the target and the identity to assume from the database", async () => {
    const { deps, launched } = makeDeps();
    const manager = new SessionManager(config, deps);

    const id = await manager.create(userId, siteId, "test run");

    expect(launched[0]!.targetUrl).toBe("https://target.test");
    // The identity is the target's, never BrowserPilot's own user id.
    expect(launched[0]!.user.userId).toBe("3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f");
    expect(launched[0]!.user.userId).not.toBe(userId);

    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.status).toBe("idle");
    expect(row?.title).toBe("test run");

    await manager.stop(id);
    await cleanupSessions();
  });

  test("refuses an unknown user", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    await expect(manager.create("00000000-0000-4000-8000-000000000000", siteId)).rejects.toThrow(
      SessionError,
    );
  });

  test("refuses an unknown site", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    await expect(manager.create(userId, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      /no such active site/i,
    );
  });

  test("refuses when the user has no account on that site", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    await expect(manager.create(otherUserId, siteId)).rejects.toThrow(/no account configured/i);
  });

  test("refuses a cookie-mint site with no signing secret", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    await expect(manager.create(userId, siteNoSecretId)).rejects.toThrow(/no signing secret/i);
  });

  test("a failed browser launch marks the session failed rather than leaving it live", async () => {
    const { deps } = makeDeps({
      launchBrowser: async () => {
        throw new Error("chromium exploded");
      },
    });
    const manager = new SessionManager(config, deps);

    await expect(manager.create(userId, siteId)).rejects.toThrow(/chromium exploded/);
    expect(manager.list()).toHaveLength(0);
    // Crucially it must not keep counting against the concurrency cap.
    expect(await store.liveSessionCount(userId)).toBe(0);
    await cleanupSessions();
  });
});

describe("concurrency limits", () => {
  test("the per-user limit is enforced", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await manager.create(userId, siteId));

    await expect(manager.create(userId, siteId)).rejects.toThrow(/already have 3 browsers/i);

    for (const id of ids) await manager.stop(id);
    await cleanupSessions();
  }, DB_HEAVY_TIMEOUT_MS);

  test("stopping a session frees a slot", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await manager.create(userId, siteId));
    await manager.stop(ids[0]!);

    const replacement = await manager.create(userId, siteId);
    expect(typeof replacement).toBe("string");

    await manager.stop(ids[1]!);
    await manager.stop(ids[2]!);
    await manager.stop(replacement);
    await cleanupSessions();
  }, DB_HEAVY_TIMEOUT_MS);
});

describe("ownership", () => {
  test("a user sees only their own sessions; an admin sees all", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);
    const session = manager.get(id)!;

    expect(manager.listFor(userId, "USER")).toHaveLength(1);
    expect(manager.listFor(otherUserId, "USER")).toHaveLength(0);
    expect(manager.listFor(otherUserId, "ADMIN")).toHaveLength(1);

    expect(manager.canAccess(session, userId, "USER")).toBe(true);
    expect(manager.canAccess(session, otherUserId, "USER")).toBe(false);
    expect(manager.canAccess(session, otherUserId, "ADMIN")).toBe(true);

    await manager.stop(id);
    await cleanupSessions();
  });
});

describe("events and lifecycle", () => {
  test("agent events reach subscribers and are persisted for replay", async () => {
    const { deps, fire } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);

    const seen: RobotEvent[] = [];
    manager.subscribe(id, (e) => seen.push(e));
    fire({ type: "agent_text", text: "hello" });
    await Bun.sleep(200);

    expect(seen).toContainEqual({ type: "agent_text", text: "hello" });
    const stored = await store.events(id);
    expect(stored.some((e) => e.payload.type === "agent_text")).toBe(true);

    await manager.stop(id);
    await cleanupSessions();
  });

  test("an approval request moves the session to awaiting_approval", async () => {
    const { deps, fire } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);

    fire({ type: "approval_request", requestId: "apr_1", tool: "browser_click", summary: "x" });
    expect(manager.get(id)!.status).toBe("awaiting_approval");

    await manager.stop(id);
    await cleanupSessions();
  });

  test("stopping records the reason in the database", async () => {
    const { deps, closed } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);

    await manager.stop(id, "user requested");

    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.status).toBe("stopped");
    expect(row?.endedReason).toBe("user requested");
    expect(closed.browser).toBe(1);
    expect(closed.agent).toBe(1);
    await cleanupSessions();
  });

  test("sweep stops idle sessions and records why", async () => {
    const { deps, tick } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);

    tick(600_001);
    await manager.sweep();

    expect(manager.get(id)).toBeUndefined();
    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.endedReason).toBe("idle timeout");
    await cleanupSessions();
  });

  test("sweep stops sessions past the hard cap even while active", async () => {
    const { deps, tick } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(userId, siteId);

    for (let i = 0; i < 7; i++) {
      tick(599_999);
      manager.send(id, "keep alive");
    }
    await manager.sweep();

    expect(manager.get(id)).toBeUndefined();
    const [row] = await db.select().from(robotSessions).where(eq(robotSessions.id, id));
    expect(row?.endedReason).toBe("maximum duration reached");
    await cleanupSessions();
  });
});
