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

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(25);
  expect(condition()).toBe(true);
}

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
    // A Playwright MCP worker is tied to one CDP port, so recovery must replace
    // the agent as well as Chromium.
    expect(state.browserLaunches).toBe(2);
    expect(state.agentStarts).toBe(2);
    expect(state.closed.agent).toBe(1);
    await manager.stop(id);
  });

  test("an unexpected Chromium exit recovers the browser, agent, task, and preview", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);
    const activity: string[] = [];
    manager.subscribe(id, (event) => {
      if (event.type === "tool_activity") activity.push(event.summary);
    });

    manager.send(id, "search flights from PHX to Denver");
    await manager.setPreview(id, true);
    state.fireBrowserClose!();

    await waitFor(
      () =>
        state.agentStarts === 2 &&
        manager.get(id)?.previewEnabled === true &&
        manager.get(id)?.restartingBrowser !== true,
    );

    expect(state.browserLaunches).toBe(2);
    expect(state.agentStarts).toBe(2);
    expect(state.closed.agent).toBe(1);
    expect(state.screencastStarts).toBe(2);
    expect(manager.get(id)?.previewEnabled).toBe(true);
    expect(manager.get(id)?.status).toBe("working");
    expect(state.sent[1]).toContain("search flights from PHX to Denver");
    expect(activity).toContain("Browser exited and recovered automatically");
    await manager.stop(id);
  });

  test("automatic browser recovery stops after two consecutive exits", async () => {
    const { deps, state } = fakeDeps();
    const manager = new SessionManager(managerConfig, deps);
    const id = await manager.create(fx.userId, fx.siteId);
    const errors: string[] = [];
    manager.subscribe(id, (event) => {
      if (event.type === "error") errors.push(event.message);
    });

    state.fireBrowserClose!();
    await waitFor(
      () => state.agentStarts === 2 && manager.get(id)?.restartingBrowser !== true,
    );
    state.fireBrowserClose!();
    await waitFor(
      () => state.agentStarts === 3 && manager.get(id)?.restartingBrowser !== true,
    );
    state.fireBrowserClose!();
    await waitFor(() => errors.length > 0);

    expect(state.browserLaunches).toBe(3);
    expect(state.agentStarts).toBe(3);
    expect(manager.get(id)?.status).toBe("failed");
    expect(errors.at(-1)).toContain("exited repeatedly");
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
