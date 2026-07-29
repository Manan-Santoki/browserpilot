import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { SessionManager } from "../src/session/manager";
import { looksSignedOut } from "../src/session/signed-out";
import {
  DB_HEAVY_TIMEOUT_MS,
  createFixtures,
  db,
  fakeDeps,
  managerConfig,
  type Fixtures,
} from "./helpers";

/**
 * Sites nobody hands us a signing secret for: the person signs in themselves
 * once, in a browser we run, and every later session starts from the profile
 * that login left behind.
 */

let fx: Fixtures;

beforeAll(async () => {
  fx = await createFixtures("saved-login");
  // The fixture site mints cookies; this suite is about the other kind.
  await db
    .update(siteProfiles)
    .set({ loginStrategy: "persistent_profile", secretEncrypted: null })
    .where(eq(siteProfiles.id, fx.siteId));
});

afterAll(async () => {
  await fx.cleanup();
});

async function linkState(): Promise<string> {
  const [row] = await db
    .select({ linkState: siteAccounts.linkState })
    .from(siteAccounts)
    .where(and(eq(siteAccounts.userId, fx.userId), eq(siteAccounts.siteProfileId, fx.siteId)));
  return row!.linkState;
}

async function resetLink(): Promise<void> {
  await db
    .update(siteAccounts)
    .set({ linkState: "none" })
    .where(and(eq(siteAccounts.userId, fx.userId), eq(siteAccounts.siteProfileId, fx.siteId)));
}

describe("signing in to a site yourself", () => {
  test("a session is refused until the person has signed in once", async () => {
    await resetLink();
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await expect(manager.create(fx.userId, fx.siteId)).rejects.toThrow(/sign in to/i);
  }, DB_HEAVY_TIMEOUT_MS);

  test("the sign-in browser has no agent and takes the person's input", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    const id = await manager.createLogin(fx.userId, fx.siteId);
    const session = manager.get(id)!;

    expect(session.kind).toBe("login");
    expect(session.agent).toBeUndefined();
    // Nothing is instructing this browser, so no model was ever started.
    expect(state.sent).toHaveLength(0);
    // The preview is the whole point of a sign-in session, so it starts on.
    expect(session.previewEnabled).toBe(true);

    await manager.dispatchInput(id, { kind: "key", action: "char", text: "a" });
    expect(state.dispatched).toHaveLength(1);

    await manager.stop(id);
  }, DB_HEAVY_TIMEOUT_MS);

  test("saving the sign-in links the account", async () => {
    await resetLink();
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    const id = await manager.createLogin(fx.userId, fx.siteId);
    await manager.saveLogin(id);

    expect(await linkState()).toBe("linked");
    // The browser must be closed before the profile is taken, or Chromium has
    // not yet flushed the cookies the login just set.
    expect(manager.get(id)).toBeUndefined();
  }, DB_HEAVY_TIMEOUT_MS);

  test("a linked account starts sessions from a copy of its profile", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));

    const id = await manager.create(fx.userId, fx.siteId);
    expect(state.checkouts).toEqual([`${fx.siteId}:${fx.userId}`]);
    // Never the canonical profile itself — that would lock out every sibling.
    expect(manager.get(id)!.scratchProfileDir).toContain(id);

    await manager.stop(id);
  }, DB_HEAVY_TIMEOUT_MS);

  test("two sessions for one site can run at once", async () => {
    await resetLink();
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));

    const first = await manager.create(fx.userId, fx.siteId);
    const second = await manager.create(fx.userId, fx.siteId);

    expect(first).not.toBe(second);
    expect(manager.list()).toHaveLength(2);

    await manager.stop(first);
    await manager.stop(second);
  }, DB_HEAVY_TIMEOUT_MS);

  test("a finished session writes its session state back to the saved login", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));
    const id = await manager.create(fx.userId, fx.siteId);
    await manager.stop(id);

    expect(state.syncedBack).toEqual([`${fx.siteId}:${fx.userId}`]);
  }, DB_HEAVY_TIMEOUT_MS);

  test("the cookies a sign-in produced are kept and replayed into later sessions", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    // Chromium never writes a session cookie to the profile, so if this is the
    // only thing the login produced, only the explicit capture can carry it.
    state.cookiesInBrowser = [{ name: "session_c", value: "S" }];
    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));

    const [row] = await db
      .select({ sealed: siteAccounts.cookiesEncrypted })
      .from(siteAccounts)
      .where(and(eq(siteAccounts.userId, fx.userId), eq(siteAccounts.siteProfileId, fx.siteId)));

    expect(row!.sealed).toBeTruthy();
    // Sealed, not readable from the table alone.
    expect(row!.sealed).not.toContain("session_c");

    state.cookiesApplied = [];
    const id = await manager.create(fx.userId, fx.siteId);
    expect(state.cookiesApplied[0]).toEqual([{ name: "session_c", value: "S" }]);

    await manager.stop(id);
  }, DB_HEAVY_TIMEOUT_MS);

  test("a cookie the target rotated mid-session replaces the stored one", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    state.cookiesInBrowser = [{ name: "session_c", value: "first" }];
    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));

    const id = await manager.create(fx.userId, fx.siteId);
    // The target handed out a new token part-way through.
    state.cookiesInBrowser = [{ name: "session_c", value: "second" }];
    await manager.stop(id);

    state.cookiesApplied = [];
    const next = await manager.create(fx.userId, fx.siteId);
    expect(state.cookiesApplied[0]).toEqual([{ name: "session_c", value: "second" }]);

    await manager.stop(next);
  }, DB_HEAVY_TIMEOUT_MS);

  test("a cookie_mint site is never handed saved cookies", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    state.cookiesApplied = [];
    // fx.otherSite mints; it must go on minting.
    const id = await manager.create(fx.userId, fx.mintSiteId);
    expect(state.cookiesApplied[0]).toBeUndefined();

    await manager.stop(id);
  }, DB_HEAVY_TIMEOUT_MS);

  test("landing on the sign-in page marks the login expired and refuses the session", async () => {
    await resetLink();
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await manager.saveLogin(await manager.createLogin(fx.userId, fx.siteId));

    // The target has decided this session is over.
    state.landingUrl = "https://target.test/login?next=%2Fdashboard";

    await expect(manager.create(fx.userId, fx.siteId)).rejects.toThrow(/expired/i);
    expect(await linkState()).toBe("expired");
    // And it does not leave a browser running behind the failure.
    expect(manager.list()).toHaveLength(0);
  }, DB_HEAVY_TIMEOUT_MS);

  test("an expired login is refused with a message that says what to do", async () => {
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    await expect(manager.create(fx.userId, fx.siteId)).rejects.toThrow(/sign in again/i);
    await expect(manager.create(fx.userId, fx.siteId)).rejects.toMatchObject({
      code: "login_expired",
    });
  }, DB_HEAVY_TIMEOUT_MS);

  test("signing in a second time replaces the first attempt", async () => {
    await resetLink();
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    const first = await manager.createLogin(fx.userId, fx.siteId);
    const second = await manager.createLogin(fx.userId, fx.siteId);

    // Two browsers writing one profile directory produce a profile that
    // belongs to neither sign-in.
    expect(manager.get(first)).toBeUndefined();
    expect(manager.get(second)).toBeDefined();

    await manager.stop(second);
  }, DB_HEAVY_TIMEOUT_MS);

  test("a sign-in session ignores instructions meant for an agent", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);

    const id = await manager.createLogin(fx.userId, fx.siteId);
    manager.send(id, "go and do something");
    manager.approve(id, "req-1", true);

    expect(state.sent).toHaveLength(0);
    await manager.stop(id);
  }, DB_HEAVY_TIMEOUT_MS);
});

describe("recognising a signed-out page", () => {
  test("common sign-in paths are recognised", () => {
    for (const url of [
      "https://app.test/login",
      "https://app.test/signin?next=/x",
      "https://app.test/sign-in",
      "https://app.test/users/sign_in",
      "https://app.test/auth/login",
    ]) {
      expect(looksSignedOut(url)).toBe(true);
    }
  });

  test("a working page is not mistaken for a signed-out one", () => {
    for (const url of [
      "https://app.test/dashboard",
      "https://app.test/purchase-orders/login-history",
      "https://app.test/",
    ]) {
      expect(looksSignedOut(url)).toBe(false);
    }
  });

  test("a site can give its own pattern", () => {
    expect(looksSignedOut("https://app.test/welcome", "/welcome")).toBe(true);
    expect(looksSignedOut("https://app.test/account/entry", "account/(entry|door)")).toBe(true);
    expect(looksSignedOut("https://app.test/dashboard", "/welcome")).toBe(false);
  });

  test("a malformed pattern falls back to a plain substring rather than throwing", () => {
    expect(looksSignedOut("https://app.test/log[in", "/log[in")).toBe(true);
    expect(looksSignedOut("https://app.test/dashboard", "/log[in")).toBe(false);
  });
});
