import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { robotSessions } from "@browserpilot/db";
import { DB_HEAVY_TIMEOUT_MS, createFixtures, db, store, type Fixtures } from "./helpers";

/**
 * A session the runtime is no longer holding.
 *
 * When a runtime restarts it declares the previous run's sessions interrupted,
 * but the process it replaced can still be alive for a moment and still
 * writing. That overlap once left a row reading "needs you" for ever: a live
 * status with an ended timestamp, which no sweep would revisit and no stop
 * request could reach, because no runtime held the session any more.
 */

let fx: Fixtures;

beforeAll(async () => {
  fx = await createFixtures("stuck");
});

afterAll(async () => {
  await fx.cleanup();
});

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: robotSessions.status, endedAt: robotSessions.endedAt })
    .from(robotSessions)
    .where(eq(robotSessions.id, id));
  return row!;
}

describe("a session that has already finished", () => {
  test("cannot be put back into a live status by a straggling write", async () => {
    const id = await store.createSession({ userId: fx.userId, siteProfileId: fx.siteId });
    await store.setStatus(id, "interrupted", "runtime restarted");

    // The replaced process, still alive, reporting on a session it has lost.
    await store.setStatus(id, "awaiting_approval");
    await store.setStatus(id, "working");

    expect((await statusOf(id)).status).toBe("interrupted");
  }, DB_HEAVY_TIMEOUT_MS);

  test("is not resurrected by an event arriving after it ended", async () => {
    const id = await store.createSession({ userId: fx.userId, siteProfileId: fx.siteId });
    await store.setStatus(id, "stopped", "stopped by user");

    await store.appendEvent(id, { type: "tool_activity", tool: "browser_click", summary: "late" });
    await store.setStatus(id, "idle");

    expect((await statusOf(id)).status).toBe("stopped");
  }, DB_HEAVY_TIMEOUT_MS);
});

describe("clearing a session the runtime no longer holds", () => {
  test("the sweep judges by status, not by a stale ended timestamp", async () => {
    const id = await store.createSession({ userId: fx.userId, siteProfileId: fx.siteId });

    // Exactly the shape the bug produced: live status, ended timestamp set.
    await db
      .update(robotSessions)
      .set({ status: "awaiting_approval", endedAt: new Date(), endedReason: "runtime restarted" })
      .where(eq(robotSessions.id, id));

    await store.markOrphansInterrupted();

    expect((await statusOf(id)).status).toBe("interrupted");
  }, DB_HEAVY_TIMEOUT_MS);

  test("forceStop ends a live row and reports that it did", async () => {
    const id = await store.createSession({ userId: fx.userId, siteProfileId: fx.siteId });
    await store.setStatus(id, "awaiting_approval");

    expect(await store.forceStop(id, "browser was already gone")).toBe(true);

    const row = await statusOf(id);
    expect(row.status).toBe("stopped");
    expect(row.endedAt).not.toBeNull();

    // Nothing left to clear the second time, which is how the caller knows.
    expect(await store.forceStop(id, "browser was already gone")).toBe(false);
  }, DB_HEAVY_TIMEOUT_MS);

  test("a stuck session stops counting against the concurrency limit", async () => {
    const before = await store.liveSessionCount(fx.userId);

    const id = await store.createSession({ userId: fx.userId, siteProfileId: fx.siteId });
    await store.setStatus(id, "awaiting_approval");
    expect(await store.liveSessionCount(fx.userId)).toBe(before + 1);

    await store.forceStop(id, "browser was already gone");
    expect(await store.liveSessionCount(fx.userId)).toBe(before);
  }, DB_HEAVY_TIMEOUT_MS);
});
