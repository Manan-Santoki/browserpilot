import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mintTicket } from "@browserpilot/core";
import { createServer } from "../src/http/routes";
import { SessionManager } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";
import { createFixtures, fakeDeps, managerConfig, store, type Fixtures } from "./helpers";

const TICKET_SECRET = "routes-ticket-secret";
let fx: Fixtures;
let running: { stop(): void } | undefined;

beforeAll(async () => {
  fx = await createFixtures("routes");
});

afterEach(() => {
  running?.stop();
  running = undefined;
});

afterAll(async () => {
  await fx.cleanup();
});

function start() {
  const { deps, state } = fakeDeps();
  const manager = new SessionManager(managerConfig, deps);
  const handle = createServer(manager, {
    port: 0,
    ticketSecret: TICKET_SECRET,
    store,
    downloadsRoot: managerConfig.downloadsRoot,
  });
  running = handle;
  return { manager, state, port: handle.server.port };
}

const ticketFor = (sessionId: string, userId: string, role: "ADMIN" | "USER" = "USER") =>
  mintTicket({ sessionId, userId, role }, TICKET_SECRET);

describe("authentication", () => {
  test("health is the only route reachable without a ticket", async () => {
    const { port } = start();
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/sessions`)).status).toBe(401);
  });

  test("a ticket signed with the wrong secret is refused", async () => {
    const { port } = start();
    const bad = await mintTicket(
      { sessionId: "any", userId: fx.userId, role: "USER" },
      "not-the-secret",
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${bad}` },
    });
    expect(res.status).toBe(401);
  });

  test("an expired ticket is refused", async () => {
    const { port } = start();
    const expired = await mintTicket(
      { sessionId: "any", userId: fx.userId, role: "USER" },
      TICKET_SECRET,
      -1,
    );
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("session routes", () => {
  test("creating a session requires a site and returns its id", async () => {
    const { port, manager } = start();
    const ticket = await ticketFor("pending", fx.userId);

    const missing = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId }),
    });
    expect(res.status).toBe(200);

    const { id } = (await res.json()) as { id: string };
    expect(manager.get(id)).toBeDefined();
    await manager.stop(id);
  });

  test("a user with no account on the site gets a specific 409", async () => {
    const { port } = start();
    const ticket = await ticketFor("pending", fx.otherUserId);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "no_site_account" });
  });

  test("listing shows only your own sessions unless you are an admin", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);

    const mine = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${await ticketFor(id, fx.userId)}` },
    }).then((r) => r.json())) as { sessions: unknown[] };
    expect(mine.sessions).toHaveLength(1);

    const theirs = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId)}` },
    }).then((r) => r.json())) as { sessions: unknown[] };
    expect(theirs.sessions).toHaveLength(0);

    const admin = (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId, "ADMIN")}` },
    }).then((r) => r.json())) as { sessions: unknown[] };
    expect(admin.sessions).toHaveLength(1);

    await manager.stop(id);
  });

  test("another user cannot stop your session, but an admin can", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);

    const denied = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId)}` },
    });
    expect(denied.status).toBe(403);
    expect(manager.get(id)).toBeDefined();

    const allowed = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId, "ADMIN")}` },
    });
    expect(allowed.status).toBe(200);
    expect(manager.get(id)).toBeUndefined();
  });
});

describe("WebSocket", () => {
  test("a ticket for a different session cannot open the socket", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    const wrong = await ticketFor("some-other-session", fx.userId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}?ticket=${wrong}`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      ws.onopen = () => resolve(false);
    });

    expect(closed).toBe(true);
    await manager.stop(id);
  });

  test("the owner's ticket opens the socket and receives events", async () => {
    const { port, manager, state } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    const ticket = await ticketFor(id, fx.userId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}?ticket=${ticket}`);
    const received: RobotEvent[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") received.push(JSON.parse(e.data));
    };
    await new Promise((resolve) => (ws.onopen = resolve));

    expect(received[0]).toEqual({ type: "session_status", status: "idle" });

    state.emit!({ type: "agent_text", text: "hello from robot" });
    await Bun.sleep(100);
    expect(received).toContainEqual({ type: "agent_text", text: "hello from robot" });

    ws.close();
    await manager.stop(id);
  });

  test("a user message sent over the socket reaches the agent", async () => {
    const { port, manager, state } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    const ticket = await ticketFor(id, fx.userId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}?ticket=${ticket}`);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "user_msg", text: "create a PO" }));
    await Bun.sleep(100);

    expect(state.sent).toEqual(["create a PO"]);
    ws.close();
    await manager.stop(id);
  });

  test("preview frames arrive as binary on the same socket", async () => {
    const { port, manager, state } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    const ticket = await ticketFor(id, fx.userId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${id}?ticket=${ticket}`);
    ws.binaryType = "arraybuffer";
    let binaryFrames = 0;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") binaryFrames++;
    };
    await new Promise((resolve) => (ws.onopen = resolve));

    ws.send(JSON.stringify({ type: "preview", enabled: true }));
    await Bun.sleep(120);
    state.pushFrame!(Buffer.from("fake-jpeg").toString("base64"));
    await Bun.sleep(120);

    expect(binaryFrames).toBe(1);
    ws.close();
    await manager.stop(id);
  });

  test("a socket for an unknown session is rejected", async () => {
    const { port } = start();
    const ticket = await ticketFor("does-not-exist", fx.userId);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/does-not-exist?ticket=${ticket}`);

    const closed = await new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      ws.onopen = () => resolve(false);
    });
    expect(closed).toBe(true);
  });
});

describe("restarting a browser", () => {
  test("replaces the browser without ending the session", async () => {
    const { port, manager, state } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    const before = manager.get(id)!.browser;

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(id, fx.userId)}` },
    });

    expect(res.status).toBe(200);
    // The session survives; only its browser is new.
    expect(manager.get(id)).toBeDefined();
    expect(manager.get(id)!.browser).not.toBe(before);
    expect(state.closed.browser).toBe(1);
    // The agent is told, rather than left holding tools for a dead browser.
    expect(state.sent.some((m) => /restarted/i.test(m))).toBe(true);

    await manager.stop(id);
  });

  test("another user cannot restart your browser", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId)}` },
    });

    expect(res.status).toBe(403);
    await manager.stop(id);
  });
});

describe("model selection", () => {
  test("a per-session model overrides the configured default", async () => {
    const { port, manager } = start();
    const ticket = await ticketFor("pending", fx.userId);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId, model: "claude-sonnet-5" }),
    });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    await manager.stop(id);
  });
});

describe("downloads outlive their session", () => {
  test("a file from a stopped session is still served to its owner", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);

    // Put a file where the session's downloads live, then end the session.
    const dir = `${managerConfig.downloadsRoot}/${id}`;
    await Bun.write(`${dir}/report.pdf`, "%PDF-1.4 fake");
    await manager.stop(id);
    expect(manager.get(id)).toBeUndefined();

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/files/report.pdf`, {
      headers: { authorization: `Bearer ${await ticketFor(id, fx.userId)}` },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("%PDF");
  });

  test("someone else still cannot fetch it", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    await Bun.write(`${managerConfig.downloadsRoot}/${id}/private.pdf`, "%PDF-1.4 secret");
    await manager.stop(id);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/files/private.pdf`, {
      headers: { authorization: `Bearer ${await ticketFor(id, fx.otherUserId)}` },
    });
    expect(res.status).toBe(403);
  });

  test("a path-traversal filename cannot escape the session directory", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);
    await manager.stop(id);

    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${id}/files/${encodeURIComponent("../../etc/passwd")}`,
      { headers: { authorization: `Bearer ${await ticketFor(id, fx.userId)}` } },
    );
    expect(res.status).toBe(404);
  });
});
