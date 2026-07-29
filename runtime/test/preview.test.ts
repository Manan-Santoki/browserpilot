import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SessionManager } from "../src/session/manager";
import { createFixtures, fakeDeps, managerConfig, type Fixtures } from "./helpers";

let fx: Fixtures;

beforeAll(async () => {
  fx = await createFixtures("preview");
});

afterAll(async () => {
  await fx.cleanup();
});

describe("live preview", () => {
  test("enabling preview starts the screencast once", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    await manager.setPreview(id, true);
    await manager.setPreview(id, true);

    expect(state.screencastStarts).toBe(1);
    await manager.stop(id);
  });

  test("frames reach frame subscribers", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    const frames: string[] = [];
    manager.subscribeFrames(id, (f) => frames.push(f));
    await manager.setPreview(id, true);
    state.pushFrame!("/9j/fake-frame");

    expect(frames).toEqual(["/9j/fake-frame"]);
    await manager.stop(id);
  });

  test("a client that connects late is shown the last frame at once", async () => {
    // Otherwise a reload leaves the panel empty until the page next repaints —
    // for a browser sitting on a finished form, that is indefinitely.
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    await manager.setPreview(id, true);
    state.pushFrame!("/9j/first");
    state.pushFrame!("/9j/newest");

    const late: string[] = [];
    manager.subscribeFrames(id, (f) => late.push(f));

    expect(late).toEqual(["/9j/newest"]);
    await manager.stop(id);
  });

  test("restarting the browser drops the cached frame", async () => {
    // It shows a browser that no longer exists.
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    await manager.setPreview(id, true);
    state.pushFrame!("/9j/stale");
    await manager.restartBrowser(id);

    const late: string[] = [];
    manager.subscribeFrames(id, (f) => late.push(f));

    expect(late).toEqual([]);
    await manager.stop(id);
  });

  test("preview_state tells subscribers whether frames are flowing", async () => {
    const { deps } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    const events: string[] = [];
    manager.subscribe(id, (e) => {
      if (e.type === "preview_state") events.push(String(e.enabled));
    });

    await manager.setPreview(id, true);
    await manager.setPreview(id, false);

    expect(events).toEqual(["true", "false"]);
    await manager.stop(id);
  });

  test("disabling preview stops the screencast", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    await manager.setPreview(id, true);
    await manager.setPreview(id, false);

    expect(state.screencastStops).toBe(1);
    await manager.stop(id);
  });

  test("stopping a session with preview on stops the screencast too", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);

    await manager.setPreview(id, true);
    await manager.stop(id);

    expect(state.screencastStops).toBe(1);
  });
});
