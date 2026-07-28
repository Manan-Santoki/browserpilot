import { eq } from "drizzle-orm";
import { encryptSecret } from "@browserpilot/core";
import { createDatabase, robotSessions, siteAccounts, siteProfiles, users } from "@browserpilot/db";
import { Store } from "../src/store";
import type { ManagerDeps } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";
import type { RobotBrowser } from "../src/browser/chromium";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot";
export const TEST_MASTER_KEY = "k".repeat(44);

export const db = createDatabase(TEST_DATABASE_URL, { max: 3 });
export const store = new Store(TEST_DATABASE_URL, TEST_MASTER_KEY);

export type Fixtures = {
  userId: string;
  otherUserId: string;
  siteId: string;
  cleanup: () => Promise<void>;
};

/** A user with an identity on one site — the minimum to start a session. */
export async function createFixtures(prefix: string): Promise<Fixtures> {
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

  await db.insert(siteAccounts).values({
    siteProfileId: site!.id,
    userId: user!.id,
    targetUserId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
    targetEmail: "person@target.test",
    targetName: "Person",
    targetRole: "admin",
  });

  return {
    userId: user!.id,
    otherUserId: other!.id,
    siteId: site!.id,
    cleanup: async () => {
      await db.delete(robotSessions).where(eq(robotSessions.userId, user!.id));
      await db.delete(users).where(eq(users.id, user!.id));
      await db.delete(users).where(eq(users.id, other!.id));
      await db.delete(siteProfiles).where(eq(siteProfiles.id, site!.id));
    },
  };
}

export type FakeBrowserState = {
  fireDownload?: (d: { suggestedFilename: string; saveAs: (p: string) => Promise<void> }) => void;
  pushFrame?: (frame: string) => void;
  screencastStarts: number;
  screencastStops: number;
  emit?: (event: RobotEvent) => void;
  sent: string[];
  closed: { browser: number; agent: number };
};

/** Manager dependencies backed by fakes, so no browser or model is involved. */
export function fakeDeps(overrides: Partial<ManagerDeps> = {}) {
  const state: FakeBrowserState = {
    screencastStarts: 0,
    screencastStops: 0,
    sent: [],
    closed: { browser: 0, agent: 0 },
  };
  let clock = 1_000;

  const deps: ManagerDeps = {
    store,
    now: () => clock,
    launchBrowser: async (args): Promise<RobotBrowser> => ({
      cdpEndpoint: "http://127.0.0.1:1",
      downloadsDir: args.downloadsDir,
      page: {} as never,
      context: {} as never,
      onDownload: (handler) => {
        state.fireDownload = handler;
      },
      close: async () => {
        state.closed.browser++;
      },
    }),
    startAgent: async (args) => {
      state.emit = args.onEvent;
      return {
        send: (t: string) => state.sent.push(t),
        approve: () => {},
        stop: async () => {
          state.closed.agent++;
        },
      };
    },
    startScreencast: async (_page, onFrame) => {
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

export const managerConfig = { downloadsRoot: "/tmp/bp-test-downloads", env: {} };
