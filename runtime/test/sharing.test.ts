import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mintTicket } from "@browserpilot/core";
import { sessionShares } from "@browserpilot/db";
import { createLocalStore } from "../src/storage/object-store";
import { createServer } from "../src/http/routes";
import { SessionManager } from "../src/session/manager";
import { createFixtures, db, fakeDeps, managerConfig, store, type Fixtures } from "./helpers";

/**
 * Watching someone else's session.
 *
 * The property under test is a split, not a switch: seeing a session and
 * operating one are different rights. A colleague you share with should be
 * able to watch the browser and read the conversation, and should not be able
 * to type into it, answer an approval, or stop it — because the person who
 * owns the session is the one accountable for what it does.
 */

const TICKET_SECRET = "sharing-ticket-secret";
let fx: Fixtures;
let running: { stop(): void } | undefined;

beforeAll(async () => {
  fx = await createFixtures("sharing");
});

afterEach(async () => {
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
  });
  running = handle;
  // Bun types the port as optional; it is always set for a listening server,
  // and every helper below needs a definite number to build a URL from.
  return { manager, state, port: handle.server.port as number };
}

const ticketFor = (
  sessionId: string,
  userId: string,
  role: "ADMIN" | "USER" = "USER",
  perms: string[] = ["session.start"],
) => mintTicket({ sessionId, userId, role, perms }, TICKET_SECRET);

/** Start a session owned by the fixture user, and hand back its id. */
async function ownedSession(port: number): Promise<string> {
  const ticket = await ticketFor("pending", fx.userId);
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
    body: JSON.stringify({ siteProfileId: fx.siteId }),
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

const share = (sessionId: string, userId: string) =>
  db.insert(sessionShares).values({ robotSessionId: sessionId, userId, grantedById: fx.userId });

const unshare = (sessionId: string) =>
  db.delete(sessionShares).where(eq(sessionShares.robotSessionId, sessionId));

/** Open a socket and collect what it is sent. */
function connect(port: number, sessionId: string, ticket: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}?ticket=${ticket}`);
  const events: Array<Record<string, unknown>> = [];
  ws.onmessage = (e) => {
    if (typeof e.data === "string") events.push(JSON.parse(e.data));
  };
  const open = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket refused"));
  });
  return { ws, events, open };
}

describe("who may watch a session", () => {
  test("a stranger cannot open its socket", async () => {
    const { port, manager } = start();
    const id = await ownedSession(port);

    const ticket = await ticketFor(id, fx.otherUserId);
    const res = await fetch(`http://127.0.0.1:${port}/ws/${id}?ticket=${ticket}`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });

    expect(res.status).toBe(403);
    await manager.stop(id);
  });

  test("someone it was shared with can", async () => {
    const { port, manager } = start();
    const id = await ownedSession(port);
    await share(id, fx.otherUserId);

    const { ws, open } = connect(port, id, await ticketFor(id, fx.otherUserId));
    await open;
    ws.close();

    await unshare(id);
    await manager.stop(id);
  });

  test("so can someone holding session.view_others, with no share row", async () => {
    // The permission is for supervision — it should not require the owner to
    // have thought of you first.
    const { port, manager } = start();
    const id = await ownedSession(port);

    const ticket = await ticketFor(id, fx.otherUserId, "USER", ["session.view_others"]);
    const { ws, open } = connect(port, id, ticket);
    await open;
    ws.close();

    await manager.stop(id);
  });
});

describe("what a viewer may not do", () => {
  /** Open a viewer's socket on a shared session, and let it settle. */
  async function viewing(port: number, id: string) {
    await share(id, fx.otherUserId);
    const { ws, events, open } = connect(port, id, await ticketFor(id, fx.otherUserId));
    await open;
    await Bun.sleep(50);
    events.length = 0;
    return { ws, events };
  }

  test("typing into it is ignored", async () => {
    // Enforced on the server, not by hiding the composer: a client is not a
    // security boundary, and this socket is reachable with any HTTP tool.
    const { port, manager, state } = start();
    const id = await ownedSession(port);
    const { ws } = await viewing(port, id);

    ws.send(JSON.stringify({ type: "user_msg", text: "delete everything" }));
    await Bun.sleep(100);

    expect(state.sent).toHaveLength(0);

    ws.close();
    await unshare(id);
    await manager.stop(id);
  });

  test("stopping it is ignored", async () => {
    const { port, manager } = start();
    const id = await ownedSession(port);
    const { ws } = await viewing(port, id);

    ws.send(JSON.stringify({ type: "stop" }));
    await Bun.sleep(100);

    expect(manager.get(id)?.status).not.toBe("stopped");

    ws.close();
    await unshare(id);
    await manager.stop(id);
  });

  test("but the owner's own message still gets through", async () => {
    // The guard has to refuse the viewer without muting the session.
    const { port, manager, state } = start();
    const id = await ownedSession(port);
    const { ws } = await viewing(port, id);

    const owner = connect(port, id, await ticketFor(id, fx.userId));
    await owner.open;
    owner.ws.send(JSON.stringify({ type: "user_msg", text: "check the orders page" }));
    await Bun.sleep(100);

    expect(state.sent).toEqual(["check the orders page"]);

    owner.ws.close();
    ws.close();
    await unshare(id);
    await manager.stop(id);
  });

  test("a viewer with session.approve may answer an approval", async () => {
    // The one deliberate exception: that permission exists precisely so a
    // second person can unblock a colleague's session.
    const { port, manager } = start();
    const id = await ownedSession(port);
    await share(id, fx.otherUserId);

    const ticket = await ticketFor(id, fx.otherUserId, "USER", ["session.approve"]);
    const { ws, open } = connect(port, id, ticket);
    await open;

    // No approval is pending, so this asserts only that the message is
    // accepted rather than dropped — the socket staying open is the signal.
    ws.send(JSON.stringify({ type: "approval", requestId: "apr_1", approved: true }));
    await Bun.sleep(80);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    await unshare(id);
    await manager.stop(id);
  });
});

describe("listing", () => {
  test("a shared session appears for the person it was shared with", async () => {
    const { port, manager } = start();
    const id = await ownedSession(port);
    await share(id, fx.otherUserId);

    const ticket = await ticketFor("pending", fx.otherUserId);
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${ticket}` },
    });
    const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };

    expect(sessions.map((s) => s.id)).toContain(id);

    await unshare(id);
    await manager.stop(id);
  });

  test("and does not appear for someone with no claim on it", async () => {
    const { port, manager } = start();
    const id = await ownedSession(port);

    const ticket = await ticketFor("pending", fx.otherUserId);
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: `Bearer ${ticket}` },
    });
    const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };

    expect(sessions.map((s) => s.id)).not.toContain(id);
    await manager.stop(id);
  });
});
