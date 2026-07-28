import { describe, expect, test } from "bun:test";
import { SessionManager, type ManagerDeps } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";

const USER = {
  userId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
  email: "owner@jwm.test",
  role: "admin",
  name: "Manan Santoki",
};

function makeDeps(overrides: Partial<ManagerDeps> = {}) {
  const sent: string[] = [];
  const closed = { browser: 0, agent: 0 };
  let clock = 1_000;

  const deps: ManagerDeps = {
    now: () => clock,
    launchBrowser: async () => ({
      cdpEndpoint: "http://127.0.0.1:1",
      downloadsDir: "/tmp/x",
      page: {} as never,
      context: {} as never,
      close: async () => {
        closed.browser++;
      },
    }),
    startAgent: async () => ({
      send: (text: string) => sent.push(text),
      approve: () => {},
      stop: async () => {
        closed.agent++;
      },
    }),
    ...overrides,
  };

  return { deps, sent, closed, tick: (ms: number) => (clock += ms) };
}

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

describe("SessionManager", () => {
  test("creates a session that starts idle", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    expect(manager.get(id)!.status).toBe("idle");
  });

  test("enforces the concurrent session cap", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    await manager.create(USER);
    await manager.create(USER);
    await expect(manager.create(USER)).rejects.toThrow(/session limit/i);
  });

  test("a stopped session frees a slot", async () => {
    const { deps } = makeDeps();
    const manager = new SessionManager(config, deps);
    const first = await manager.create(USER);
    await manager.create(USER);
    await manager.stop(first);
    await expect(manager.create(USER)).resolves.toBeString();
  });

  test("send() forwards to the agent and marks the session working", async () => {
    const { deps, sent } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    manager.send(id, "hello robot");
    expect(sent).toEqual(["hello robot"]);
    expect(manager.get(id)!.status).toBe("working");
  });

  test("subscribers receive events emitted by the agent", async () => {
    let emit: ((e: RobotEvent) => void) | undefined;
    const { deps } = makeDeps({
      startAgent: async (o) => {
        emit = o.onEvent;
        return { send: () => {}, approve: () => {}, stop: async () => {} };
      },
    });
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);

    const seen: RobotEvent[] = [];
    manager.subscribe(id, (e) => seen.push(e));
    emit!({ type: "agent_text", text: "done" });

    expect(seen).toContainEqual({ type: "agent_text", text: "done" });
  });

  test("unsubscribe stops delivery", async () => {
    let emit: ((e: RobotEvent) => void) | undefined;
    const { deps } = makeDeps({
      startAgent: async (o) => {
        emit = o.onEvent;
        return { send: () => {}, approve: () => {}, stop: async () => {} };
      },
    });
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    const seen: RobotEvent[] = [];
    const off = manager.subscribe(id, (e) => seen.push(e));
    off();
    emit!({ type: "agent_text", text: "ignored" });
    expect(seen).toHaveLength(0);
  });

  test("an approval_request event moves the session to awaiting_approval", async () => {
    let emit: ((e: RobotEvent) => void) | undefined;
    const { deps } = makeDeps({
      startAgent: async (o) => {
        emit = o.onEvent;
        return { send: () => {}, approve: () => {}, stop: async () => {} };
      },
    });
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    emit!({ type: "approval_request", requestId: "apr_1", tool: "browser_click", summary: "x" });
    expect(manager.get(id)!.status).toBe("awaiting_approval");
  });

  test("sweep stops sessions past the idle timeout", async () => {
    const { deps, tick, closed } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    tick(config.idleTimeoutMs + 1);
    await manager.sweep();
    expect(manager.get(id)).toBeUndefined();
    expect(closed.browser).toBe(1);
    expect(closed.agent).toBe(1);
  });

  test("activity resets the idle timer", async () => {
    const { deps, tick } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    tick(config.idleTimeoutMs - 1);
    manager.send(id, "still here");
    tick(2);
    await manager.sweep();
    expect(manager.get(id)).toBeDefined();
  });

  test("sweep stops sessions past the hard cap even when active", async () => {
    const { deps, tick } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    for (let i = 0; i < 7; i++) {
      tick(config.idleTimeoutMs - 1);
      manager.send(id, "keep alive");
    }
    await manager.sweep();
    expect(manager.get(id)).toBeUndefined();
  });

  test("stop() closes browser and agent exactly once", async () => {
    const { deps, closed } = makeDeps();
    const manager = new SessionManager(config, deps);
    const id = await manager.create(USER);
    await manager.stop(id);
    await manager.stop(id);
    expect(closed.browser).toBe(1);
    expect(closed.agent).toBe(1);
  });

  test("a failed browser launch does not leak a session slot", async () => {
    const { deps } = makeDeps({
      launchBrowser: async () => {
        throw new Error("chromium exploded");
      },
    });
    const manager = new SessionManager(config, deps);
    await expect(manager.create(USER)).rejects.toThrow(/chromium exploded/);
    expect(manager.list()).toHaveLength(0);
  });
});
