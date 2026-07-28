import { describe, expect, test } from "bun:test";
import { SessionManager, type ManagerDeps } from "../src/session/manager";

const USER = {
  userId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
  email: "owner@jwm.test",
  role: "admin",
  name: "Manan Santoki",
};

const config = {
  jwmUrl: "https://jwm.example.com",
  sessionSecret: "s",
  downloadsRoot: "/tmp/bp-test-dl",
  model: "claude-opus-5",
  maxConcurrentSessions: 2,
  idleTimeoutMs: 600_000,
  hardCapMs: 3_600_000,
  env: {},
};

function makeDeps() {
  const state = { started: 0, stopped: 0, push: undefined as ((f: string) => void) | undefined };
  const deps: ManagerDeps = {
    now: () => Date.now(),
    launchBrowser: async () => ({
      cdpEndpoint: "http://127.0.0.1:1",
      downloadsDir: "/tmp/bp-test-dl",
      page: {} as never,
      context: {} as never,
      close: async () => {},
    }),
    startAgent: async () => ({ send: () => {}, approve: () => {}, stop: async () => {} }),
    startScreencast: async (_page, onFrame) => {
      state.started++;
      state.push = onFrame;
      return {
        stop: async () => {
          state.stopped++;
        },
      };
    },
  };
  return { deps, state };
}

describe("live preview", () => {
  test("enabling preview starts the screencast once", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    await manager.setPreview(id, true);
    await manager.setPreview(id, true);

    expect(state.started).toBe(1);
  });

  test("frames reach frame subscribers", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    const frames: string[] = [];
    manager.subscribeFrames(id, (f) => frames.push(f));
    await manager.setPreview(id, true);
    state.push!("/9j/fake-frame");

    expect(frames).toEqual(["/9j/fake-frame"]);
  });

  test("disabling preview stops the screencast", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    await manager.setPreview(id, true);
    await manager.setPreview(id, false);

    expect(state.stopped).toBe(1);
  });

  test("stopping a session with preview on stops the screencast too", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    await manager.setPreview(id, true);
    await manager.stop(id);

    expect(state.stopped).toBe(1);
  });
});
