import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLocalStore, objectKey } from "../src/storage/object-store";

/** Stage a file into the object store, standing in for a real download. */
async function storeFile(sessionId: string, filename: string, body: string): Promise<void> {
  const staged = `/tmp/bp-routes-staged-${filename}`;
  await Bun.write(staged, body);
  await createLocalStore(managerConfig.downloadsRoot).put(objectKey(sessionId, filename), staged);
}
import { mintTicket } from "@browserpilot/core";
import { createServer } from "../src/http/routes";
import { SessionManager } from "../src/session/manager";
import type { RobotEvent } from "../src/session/events";
import {
  createFixtures,
  DB_HEAVY_TIMEOUT_MS,
  fakeDeps,
  managerConfig,
  store,
  type Fixtures,
} from "./helpers";

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
    objects: async () => createLocalStore(managerConfig.downloadsRoot),
    storageEnv: {},
    providerEnv: {},
    downloadsRoot: managerConfig.downloadsRoot,
    jobModeEnabled: true,
  });
  running = handle;
  return { manager, state, port: handle.server.port };
}

/**
 * A ticket for an ordinary person who is allowed to work.
 *
 * `session.start` is granted by default because that is the case nearly every
 * test is about; the tests that care about *not* having it pass `[]` and say
 * so. The console mints the same shape from the account's own permissions.
 */
const ticketFor = (
  sessionId: string,
  userId: string,
  role: "ADMIN" | "USER" = "USER",
  perms: string[] = ["session.start"],
) => mintTicket({ sessionId, userId, role, perms }, TICKET_SECRET);

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
    const activity: string[] = [];
    manager.subscribe(id, (event) => {
      if (event.type === "tool_activity") activity.push(event.summary);
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(id, fx.userId)}` },
    });

    expect(res.status).toBe(200);
    // The session survives; only its browser is new.
    expect(manager.get(id)).toBeDefined();
    expect(manager.get(id)!.browser).not.toBe(before);
    expect(state.closed.browser).toBe(1);
    // The worker is replaced too: its Playwright tools are pinned to the old
    // browser's CDP endpoint and cannot be reused.
    expect(state.agentStarts).toBe(2);
    expect(manager.get(id)!.status).toBe("idle");
    expect(activity).toContain("Browser restarted — back on the home page");

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

describe("resuming an ended session", () => {
  test("only the owner can create a linked continuation", async () => {
    const { port, manager, state } = start();
    const sourceId = await manager.create(fx.userId, fx.siteId, "resume route");
    manager.send(sourceId, "Continue my work");
    await manager.stop(sourceId);

    const denied = await fetch(`http://127.0.0.1:${port}/api/sessions/${sourceId}/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(sourceId, fx.otherUserId)}` },
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(`http://127.0.0.1:${port}/api/sessions/${sourceId}/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${await ticketFor(sourceId, fx.userId)}` },
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { id: string; resumedFromSessionId: string };
    expect(body.resumedFromSessionId).toBe(sourceId);
    expect(body.id).not.toBe(sourceId);
    expect(manager.get(body.id)?.status).toBe("working");
    expect(state.sent.at(-1)).toContain("Continue my work");

    await manager.stop(body.id);
  }, DB_HEAVY_TIMEOUT_MS);
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
    expect(manager.get(id)?.model).toBe("claude-sonnet-5");
    await manager.stop(id);
  });

  test("a model the provider no longer offers falls back rather than 404ing later", async () => {
    // The picker is built from the catalogue, but a tab left open since before
    // an admin edited it still posts the old id. Sending it onward would fail
    // on the session's first model call, long after this request returned 200.
    const { port, manager } = start();
    const ticket = await ticketFor("pending", fx.userId);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId, model: "retired-model" }),
    });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(manager.get(id)?.model).not.toBe("retired-model");
    await manager.stop(id);
  });
});

describe("permission to start a session", () => {
  test("a person without session.start is refused before a browser is launched", async () => {
    // The expensive half of starting a session is Chromium. Refusing at the
    // door rather than after the launch is the difference between a 403 and
    // 400 MB of wasted memory.
    const { port, state } = start();
    const ticket = await ticketFor("pending", fx.userId, "USER", []);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId }),
    });

    expect(res.status).toBe(403);
    expect(state.browserLaunches).toBe(0);
  });

  test("an administrator needs no permission row for it", async () => {
    // The role stays the coarse switch; permissions only refine a USER.
    const { port, manager } = start();
    const ticket = await ticketFor("pending", fx.userId, "ADMIN", []);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ siteProfileId: fx.siteId }),
    });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    await manager.stop(id);
  });
});

describe("the provider status route", () => {
  test("is admin-only — it names the endpoint a deployment talks to", async () => {
    const { port } = start();
    const ticket = await ticketFor("pending", fx.userId);

    const res = await fetch(`http://127.0.0.1:${port}/api/provider`, {
      headers: { authorization: `Bearer ${ticket}` },
    });

    expect(res.status).toBe(403);
  });
});

describe("downloads outlive their session", () => {
  test("a file from a stopped session is still served to its owner", async () => {
    const { port, manager } = start();
    const id = await manager.create(fx.userId, fx.siteId);

    // Put a file in the store the way a download would, then end the session.
    await storeFile(id, "report.pdf", "%PDF-1.4 fake");
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
    await storeFile(id, "private.pdf", "%PDF-1.4 secret");
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
