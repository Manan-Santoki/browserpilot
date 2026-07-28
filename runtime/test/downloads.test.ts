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
      },
    });
    await Bun.sleep(50);

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
      },
    });
    await Bun.sleep(50);

    expect(events.find((e) => e.type === "file_ready")).toMatchObject({ filename: "passwd" });
    // The written path must stay inside the session's own directory.
    expect(saved[0]).toContain(`/${id}/passwd`);
    expect(saved[0]).not.toContain("..");

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
