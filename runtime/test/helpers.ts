import { and, eq, inArray, like, lt } from "drizzle-orm";
import { encryptSecret } from "@browserpilot/core";
import { createDatabase, robotSessions, siteAccounts, siteProfiles, users } from "@browserpilot/db";
import { Store } from "../src/store";
import { createLocalStore } from "../src/storage/object-store";
import type { ManagerDeps } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";
import type { RobotBrowser } from "../src/browser/chromium";
import { withTestSettings } from "./support/settings";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot";
export const TEST_MASTER_KEY = "k".repeat(44);

export const db = createDatabase(TEST_DATABASE_URL, { max: 3 });
export const store = withTestSettings(new Store(TEST_DATABASE_URL, TEST_MASTER_KEY));

/**
 * Remove fixture rows a previous run left behind.
 *
 * These suites share a database with the running console, and a test that
 * times out never reaches its cleanup — so its site shows up in a real
 * person's Sites page until something removes it. Anything older than an hour
 * cannot belong to a run still in progress.
 */
async function sweepStaleFixtures(): Promise<void> {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.delete(users).where(and(like(users.email, "%@test.local"), lt(users.createdAt, anHourAgo)));
  await db
    .delete(siteProfiles)
    .where(
      and(
        inArray(siteProfiles.baseUrl, ["https://target.test", "https://nosecret.test", "https://mint.test"]),
        lt(siteProfiles.createdAt, anHourAgo),
      ),
    );
}

export type Fixtures = {
  userId: string;
  otherUserId: string;
  siteId: string;
  /** A second site that always mints, for tests that change siteId's strategy. */
  mintSiteId: string;
  cleanup: () => Promise<void>;
};

/** A user with an identity on one site — the minimum to start a session. */
export async function createFixtures(prefix: string): Promise<Fixtures> {
  await sweepStaleFixtures();
  const stamp = `${prefix}-${Date.now()}-${Math.trunc(performance.now() * 1000)}`;

  const [user] = await db
    .insert(users)
    .values({ email: `${stamp}@test.local`, name: "Fixture User", passwordHash: "x" })
    .returning();

  const [other] = await db
    .insert(users)
    .values({ email: `${stamp}-other@test.local`, name: "Other User", passwordHash: "x" })
    .returning();

  const [site] = await db
    .insert(siteProfiles)
    .values({
      name: `${stamp}-site`,
      baseUrl: "https://target.test",
      secretEncrypted: encryptSecret("site-secret", TEST_MASTER_KEY),
    })
    .returning();

  const [mintSite] = await db
    .insert(siteProfiles)
    .values({
      name: `${stamp}-mint-site`,
      baseUrl: "https://mint.test",
      secretEncrypted: encryptSecret("site-secret", TEST_MASTER_KEY),
    })
    .returning();

  for (const profileId of [site!.id, mintSite!.id]) {
    await db.insert(siteAccounts).values({
      siteProfileId: profileId,
      userId: user!.id,
      targetUserId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
      targetEmail: "person@target.test",
      targetName: "Person",
      targetRole: "admin",
    });
  }

  return {
    userId: user!.id,
    otherUserId: other!.id,
    siteId: site!.id,
    mintSiteId: mintSite!.id,
    cleanup: async () => {
      await db.delete(robotSessions).where(eq(robotSessions.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
      await db.delete(users).where(eq(users.id, other!.id));
      await db.delete(siteProfiles).where(eq(siteProfiles.id, site!.id));
      await db.delete(siteProfiles).where(eq(siteProfiles.id, mintSite!.id));
    },
  };
}

export type FakeBrowserState = {
  fireDownload?: (d: { suggestedFilename: string; saveAs: (p: string) => Promise<void> }) => void;
  pushFrame?: (frame: string) => void;
  screencastStarts: number;
  screencastStops: number;
  emit?: (event: RobotEvent) => void;
  /** The runner's route for keeping a file, as the manager wired it. */
  saveFile?: (filename: string, bytes: Uint8Array) => Promise<void>;
  sent: string[];
  closed: { browser: number; agent: number; input: number };
  /** What the target answered the opening navigation with. */
  landingUrl: string;
  /** Saved logins that "exist", keyed site:user. */
  linked: Set<string>;
  /** What the live browser would hand back when asked for its cookies. */
  cookiesInBrowser: Array<{ name: string; value: string }>;
  /** Cookies applied to each launch, so a test can see what was replayed. */
  cookiesApplied: Array<Array<{ name: string; value: string }> | undefined>;
  checkouts: string[];
  syncedBack: string[];
  dispatched: unknown[];
};

/** A profile store that records what was asked of it and touches no disk. */
function fakeProfiles(state: FakeBrowserState): ManagerDeps["profiles"] {
  const key = (site: string, user: string) => `${site}:${user}`;
  return {
    path: (site, user) => `/tmp/bp-profiles/${site}/${user}`,
    exists: async (site, user) => state.linked.has(key(site, user)),
    prepareForLogin: async (site, user) => {
      state.linked.add(key(site, user));
      return `/tmp/bp-profiles/${site}/${user}`;
    },
    checkout: async (site, user) => {
      if (!state.linked.has(key(site, user))) throw new Error("No saved login for this site");
      state.checkouts.push(key(site, user));
    },
    syncBack: async (site, user) => {
      state.syncedBack.push(key(site, user));
    },
    remove: async (site, user) => {
      state.linked.delete(key(site, user));
    },
  };
}

/** Manager dependencies backed by fakes, so no browser or model is involved. */
export function fakeDeps(overrides: Partial<ManagerDeps> = {}) {
  const state: FakeBrowserState = {
    screencastStarts: 0,
    screencastStops: 0,
    sent: [],
    closed: { browser: 0, agent: 0, input: 0 },
    landingUrl: "https://target.test/dashboard",
    linked: new Set(),
    cookiesInBrowser: [{ name: "session_c", value: "S" }],
    cookiesApplied: [],
    checkouts: [],
    syncedBack: [],
    dispatched: [],
  };
  let clock = 1_000;

  const deps: ManagerDeps = {
    store,
    profiles: fakeProfiles(state),
    objects: async () => createLocalStore("/tmp/bp-test-objects"),
    createInput: async () => ({
      dispatch: async (event) => {
        state.dispatched.push(event);
      },
      close: () => {
        state.closed.input++;
      },
    }),
    now: () => clock,
    launchBrowser: async (args): Promise<RobotBrowser> => {
      state.cookiesApplied.push(args.cookies as Array<{ name: string; value: string }> | undefined);
      return {
        cdpEndpoint: "http://127.0.0.1:1",
        downloadsDir: args.downloadsDir,
        profileDir: args.profileDir ?? "/tmp/bp-fake-profile",
        page: { url: () => state.landingUrl } as never,
        context: { cookies: async () => state.cookiesInBrowser } as never,
        onDownload: (handler) => {
          state.fireDownload = handler;
        },
        close: async () => {
          state.closed.browser++;
        },
      };
    },
    startAgent: async (args) => {
      state.emit = args.onEvent;
      state.saveFile = args.saveFile;
      return {
        send: (t: string) => state.sent.push(t),
        approve: () => {},
        stop: async () => {
          state.closed.agent++;
        },
      };
    },
    startScreencast: async (_context, onFrame) => {
      state.screencastStarts++;
      state.pushFrame = onFrame;
      return {
        stop: async () => {
          state.screencastStops++;
        },
      };
    },
    ...overrides,
  };

  return { deps, state, tick: (ms: number) => (clock += ms) };
}

/**
 * Postgres is remote in every environment this suite runs in, and a test that
 * starts and stops a few sessions is a few dozen round-trips. The 5s default is
 * a latency measurement, not a correctness one.
 */
export const DB_HEAVY_TIMEOUT_MS = 30_000;

export const managerConfig = {
  downloadsRoot: "/tmp/bp-test-downloads",
  scratchRoot: "/tmp/bp-test-scratch",
  env: {},
};
