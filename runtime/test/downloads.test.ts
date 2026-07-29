import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SessionManager } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";
import { createFixtures, fakeDeps, managerConfig, type Fixtures } from "./helpers";

let fx: Fixtures;

beforeAll(async () => {
  fx = await createFixtures("downloads");
});

afterAll(async () => {
  await fx.cleanup();
});

describe("downloads", () => {
  test("a completed download is announced with a fetchable URL", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    const events: RobotEvent[] = [];
    manager.subscribe(id, (e) => events.push(e));

    const saved: string[] = [];
    state.fireDownload!({
      suggestedFilename: "PO-2026-0142.pdf",
      saveAs: async (path) => {
        saved.push(path);
        await Bun.write(path, "%PDF-1.4 a purchase order\n");
      },
    });
    await Bun.sleep(150);

    expect(events.find((e) => e.type === "file_ready")).toMatchObject({
      type: "file_ready",
      filename: "PO-2026-0142.pdf",
      url: `/api/sessions/${id}/files/PO-2026-0142.pdf`,
    });
    expect(saved[0]).toContain("PO-2026-0142.pdf");

    await manager.stop(id);
  });

  test("a filename containing path separators is flattened before saving", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    const events: RobotEvent[] = [];
    manager.subscribe(id, (e) => events.push(e));

    const saved: string[] = [];
    state.fireDownload!({
      suggestedFilename: "../../etc/passwd",
      saveAs: async (path) => {
        saved.push(path);
        await Bun.write(path, "root:x:0:0\n");
      },
    });
    await Bun.sleep(150);

    expect(events.find((e) => e.type === "file_ready")).toMatchObject({ filename: "passwd" });
    // The written path must stay inside the session's own directory.
    expect(saved[0]).toContain(`/${id}/passwd`);
    expect(saved[0]).not.toContain("..");

    await manager.stop(id);
  });

  test("the file is put in the store, under its session, and comes back out", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    state.fireDownload!({
      suggestedFilename: "invoice.pdf",
      saveAs: async (path) => {
        await Bun.write(path, "%PDF-1.4 invoice\n");
      },
    });
    await Bun.sleep(200);

    const store = await deps.objects();
    const stored = await store.get(`sessions/${id}/invoice.pdf`);
    expect(stored).toBeDefined();
    expect(await new Response(stored!).text()).toContain("invoice");

    // And it is listed under that session rather than loose in the bucket.
    const listed = await store.list(`sessions/${id}`);
    expect(listed.map((o) => o.key)).toEqual([`sessions/${id}/invoice.pdf`]);

    await manager.stop(id);
  });

  test("a failed save surfaces as an error rather than silence", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    const events: RobotEvent[] = [];
    manager.subscribe(id, (e) => events.push(e));

    state.fireDownload!({
      suggestedFilename: "report.pdf",
      saveAs: async () => {
        throw new Error("disk full");
      },
    });
    await Bun.sleep(50);

    expect(events.find((e) => e.type === "error")).toMatchObject({
      type: "error",
      message: expect.stringContaining("disk full"),
    });

    await manager.stop(id);
  });
});
