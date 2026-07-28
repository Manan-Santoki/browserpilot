import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/http/routes";
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

let running: { stop(): void } | undefined;

function start() {
  const sent: string[] = [];
  let emit: ((e: RobotEvent) => void) | undefined;

  const deps: ManagerDeps = {
    now: () => Date.now(),
    launchBrowser: async () => ({
      cdpEndpoint: "http://127.0.0.1:1",
      downloadsDir: "/tmp/bp-test-dl",
      page: {} as never,
      context: {} as never,
      close: async () => {},
    }),
    startAgent: async (o) => {
      emit = o.onEvent;
      return {
        send: (t: string) => sent.push(t),
        approve: () => {},
        stop: async () => {},
      };
    },
  };

  const manager = new SessionManager(config, deps);
  const handle = createServer(manager, { port: 0, debugUser: USER, publicDir: "./public" });
  running = handle;
  return {
    manager,
    sent,
    port: handle.server.port,
    fire: (e: RobotEvent) => emit!(e),
  };
}

afterEach(() => {
  running?.stop();
  running = undefined;
});

describe("HTTP routes", () => {
  test("POST /api/sessions creates a session and returns its id", async () => {
    const { port, manager } = start();
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(manager.get(body.id)).toBeDefined();
  });

  test("GET /api/sessions lists sessions without leaking internals", async () => {
    const { port } = start();
    await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
    const body = (await fetch(`http://127.0.0.1:${port}/api/sessions`).then((r) => r.json())) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toHaveProperty("status");
    expect(body.sessions[0]).not.toHaveProperty("browser");
    expect(body.sessions[0]).not.toHaveProperty("agent");
  });

  test("POST /api/sessions/:id/stop removes the session", async () => {
    const { port, manager } = start();
    const { id } = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
    }).then((r) => r.json())) as { id: string };

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(manager.get(id)).toBeUndefined();
  });

  test("returns 404 for an unknown session", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/nope/stop`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("returns 429 when the session cap is reached", async () => {
    const { port } = start();
    await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
    await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(429);
  });
});

describe("WebSocket", () => {
  test("forwards agent events to the connected client", async () => {
    const { port, fire } = start();
    const { id } = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
    }).then((r) => r.json())) as { id: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`);
    const received: RobotEvent[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") received.push(JSON.parse(e.data));
    };
    await new Promise((resolve) => (ws.onopen = resolve));

    fire({ type: "agent_text", text: "hello from robot" });
    await Bun.sleep(50);

    expect(received).toContainEqual({ type: "agent_text", text: "hello from robot" });
    ws.close();
  });

  test("a user_msg command reaches the agent", async () => {
    const { port, sent } = start();
    const { id } = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
    }).then((r) => r.json())) as { id: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "user_msg", text: "create a PO" }));
    await Bun.sleep(50);

    expect(sent).toEqual(["create a PO"]);
    ws.close();
  });

  test("sends the current status on connect", async () => {
    const { port } = start();
    const { id } = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
    }).then((r) => r.json())) as { id: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}`);
    const first = await new Promise<RobotEvent>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
    });

    expect(first).toEqual({ type: "session_status", status: "idle" });
    ws.close();
  });

  test("rejects a socket for an unknown session", async () => {
    const { port } = start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/does-not-exist`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      ws.onopen = () => resolve(false);
    });
    expect(closed).toBe(true);
  });
});
