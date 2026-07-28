import { describe, expect, test } from "bun:test";
import { SessionManager, type ManagerDeps } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";

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
  const state = {
    fire: undefined as
      | ((d: { suggestedFilename: string; saveAs: (p: string) => Promise<void> }) => void)
      | undefined,
    savedTo: [] as string[],
  };

  const deps: ManagerDeps = {
    now: () => Date.now(),
    startAgent: async () => ({ send: () => {}, approve: () => {}, stop: async () => {} }),
    startScreencast: async () => ({ stop: async () => {} }),
    launchBrowser: async (args) => ({
      cdpEndpoint: "http://127.0.0.1:1",
      downloadsDir: args.downloadsDir,
      page: {} as never,
      context: {} as never,
      close: async () => {},
      onDownload: (handler) => {
        state.fire = handler;
      },
    }),
  };

  return { deps, state };
}

describe("downloads", () => {
  test("a completed download emits file_ready with a fetchable URL", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    const events: RobotEvent[] = [];
    manager.subscribe(id, (e) => events.push(e));

    state.fire!({
      suggestedFilename: "PO-2026-0142.pdf",
      saveAs: async (path) => {
        state.savedTo.push(path);
      },
    });
    await Bun.sleep(20);

    const ready = events.find((e) => e.type === "file_ready");
    expect(ready).toMatchObject({
      type: "file_ready",
      filename: "PO-2026-0142.pdf",
      url: `/api/sessions/${id}/files/PO-2026-0142.pdf`,
    });
    expect(state.savedTo[0]).toContain("PO-2026-0142.pdf");
  });

  test("a filename containing path separators is flattened before saving", async () => {
    const { deps, state } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    const events: RobotEvent[] = [];
    manager.subscribe(id, (e) => events.push(e));

    state.fire!({ suggestedFilename: "../../etc/passwd", saveAs: async () => {} });
    await Bun.sleep(20);

    const ready = events.find((e) => e.type === "file_ready");
    expect(ready).toMatchObject({ filename: "passwd" });
  });
});
