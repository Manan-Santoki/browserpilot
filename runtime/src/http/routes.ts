import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { verifyTicket, type TicketClaims } from "@browserpilot/core";
import type { ClientCommand, RobotEvent } from "../session/events";
import { SessionError, type SessionManager } from "../session/manager";
import type { Store } from "../store";
import { contentTypeFor } from "@browserpilot/core";
import { objectKey, type ObjectStore } from "../storage/object-store";

type SocketData = {
  sessionId: string;
  claims: TicketClaims;
  unsubscribe?: () => void;
  unsubscribeFrames?: () => void;
};

export type ServerOptions = {
  port: number;
  ticketSecret: string;
  store: Store;
  /** Where session downloads are kept. */
  objects: () => Promise<ObjectStore>;
  /** Where per-session download directories live. */
  downloadsRoot: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** HTTP status for each way a session can be refused. */
const STATUS_FOR: Record<SessionError["code"], number> = {
  unknown_user: 403,
  unknown_site: 404,
  no_site_account: 409,
  missing_secret: 409,
  site_limit: 429,
  user_limit: 429,
  global_limit: 429,
  not_linked: 409,
  login_expired: 409,
};

export function createServer(manager: SessionManager, opts: ServerOptions) {
  /**
   * Every request carries a ticket minted by the console. The runtime has no
   * user accounts of its own and no unauthenticated routes — the Phase 1
   * "do not expose this publicly" caveat is gone with them.
   */
  async function claimsFor(req: Request, url: URL): Promise<TicketClaims | null> {
    const header = req.headers.get("authorization");
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    // Browsers cannot set headers on a WebSocket handshake, so the ticket may
    // also arrive as a query parameter. It is single-use-ish and expires in a
    // minute, which is what makes that acceptable.
    const ticket = bearer ?? url.searchParams.get("ticket");
    if (!ticket) return null;
    return verifyTicket(ticket, opts.ticketSecret);
  }

  const server = Bun.serve<SocketData>({
    port: opts.port,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") return json({ ok: true });

      const claims = await claimsFor(req, url);
      if (!claims) return json({ error: "A valid ticket is required" }, 401);

      const wsMatch = /^\/ws\/([^/]+)$/.exec(path);
      if (wsMatch) {
        const sessionId = wsMatch[1]!;
        const session = manager.get(sessionId);
        if (!session) return json({ error: "No such session" }, 404);
        // A ticket is scoped to one session; presenting it for another is a
        // privilege-escalation attempt, not a routing mistake.
        if (claims.sessionId !== sessionId) return json({ error: "Ticket is for another session" }, 403);
        if (!manager.canAccess(session, claims.userId, claims.role)) {
          return json({ error: "Not your session" }, 403);
        }
        if (srv.upgrade(req, { data: { sessionId, claims } })) {
          return undefined as unknown as Response;
        }
        return json({ error: "Expected a WebSocket upgrade" }, 426);
      }

      if (path === "/api/sessions" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          siteProfileId?: string;
          title?: string;
          model?: string;
        };
        if (!body.siteProfileId) return json({ error: "siteProfileId is required" }, 400);

        try {
          const id = await manager.create(
            claims.userId,
            body.siteProfileId,
            body.title,
            body.model,
          );
          return json({ id });
        } catch (error) {
          if (error instanceof SessionError) {
            return json({ error: error.message, code: error.code }, STATUS_FOR[error.code]);
          }
          return json({ error: (error as Error).message }, 500);
        }
      }

      if (path === "/api/sessions" && req.method === "GET") {
        return json({
          sessions: manager.listFor(claims.userId, claims.role).map((s) => ({
            id: s.id,
            userId: s.userId,
            siteName: s.siteName,
            status: s.status,
            startedAt: s.startedAt,
            lastActivityAt: s.lastActivityAt,
            previewEnabled: s.previewEnabled,
          })),
        });
      }

      // Open a browser for the person to sign in to a site themselves.
      if (path === "/api/logins" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { siteProfileId?: string };
        if (!body.siteProfileId) return json({ error: "siteProfileId is required" }, 400);

        try {
          const id = await manager.createLogin(claims.userId, body.siteProfileId);
          return json({ id });
        } catch (error) {
          if (error instanceof SessionError) {
            return json({ error: error.message, code: error.code }, STATUS_FOR[error.code]);
          }
          return json({ error: (error as Error).message }, 500);
        }
      }

      const saveLoginMatch = /^\/api\/logins\/([^/]+)\/save$/.exec(path);
      if (saveLoginMatch && req.method === "POST") {
        const session = manager.get(saveLoginMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
        // A saved login is that person's own; an admin has no business
        // adopting it, so this is an ownership check rather than canAccess.
        if (session.userId !== claims.userId) return json({ error: "Not your sign-in" }, 403);

        try {
          await manager.saveLogin(session.id);
          return json({ ok: true });
        } catch (error) {
          return json({ error: (error as Error).message }, 400);
        }
      }

      const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path);
      if (stopMatch && req.method === "POST") {
        const id = stopMatch[1]!;
        const session = manager.get(id);

        // A session this runtime never knew about, or lost to a restart, still
        // has a row that reads as running and still counts against a person's
        // limit. Stop has to work on it, or nothing ever will.
        if (!session) {
          const owner = await opts.store.sessionOwner(id);
          if (!owner) return json({ error: "No such session" }, 404);
          if (claims.role !== "ADMIN" && owner !== claims.userId) {
            return json({ error: "Not your session" }, 403);
          }
          const cleared = await opts.store.forceStop(id, "browser was already gone");
          return json({ ok: true, cleared });
        }

        if (!manager.canAccess(session, claims.userId, claims.role)) {
          return json({ error: "Not your session" }, 403);
        }
        await manager.stop(session.id);
        return json({ ok: true });
      }

      const restartMatch = /^\/api\/sessions\/([^/]+)\/restart$/.exec(path);
      if (restartMatch && req.method === "POST") {
        const session = manager.get(restartMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
        if (!manager.canAccess(session, claims.userId, claims.role)) {
          return json({ error: "Not your session" }, 403);
        }
        try {
          await manager.restartBrowser(session.id);
          return json({ ok: true });
        } catch (error) {
          if (error instanceof SessionError) {
            return json({ error: error.message, code: error.code }, STATUS_FOR[error.code]);
          }
          return json({ error: (error as Error).message }, 500);
        }
      }

      const fileListMatch = /^\/api\/sessions\/([^/]+)\/files$/.exec(path);
      if (fileListMatch && req.method === "GET") {
        const sessionId = fileListMatch[1]!;
        const ownerId = await opts.store.sessionOwner(sessionId);
        if (!ownerId) return json({ error: "No such session" }, 404);
        if (claims.role !== "ADMIN" && ownerId !== claims.userId) {
          return json({ error: "Not your session" }, 403);
        }

        const store = await opts.objects();
        const objects = await store.list(`sessions/${sessionId}`);
        return json({
          files: objects.map((object) => ({
            filename: object.key.slice(object.key.lastIndexOf("/") + 1),
            size: object.size,
            updatedAt: object.updatedAt.toISOString(),
          })),
        });
      }

      const fileMatch = /^\/api\/sessions\/([^/]+)\/files\/(.+)$/.exec(path);
      if (fileMatch && req.method === "GET") {
        const sessionId = fileMatch[1]!;
        const live = manager.get(sessionId);

        // A finished session still has its files on disk, so fall back to the
        // database for ownership rather than refusing everything after a stop.
        if (live) {
          if (!manager.canAccess(live, claims.userId, claims.role)) {
            return json({ error: "Not your session" }, 403);
          }
        } else {
          const ownerId = await opts.store.sessionOwner(sessionId);
          if (!ownerId) return json({ error: "No such session" }, 404);
          if (claims.role !== "ADMIN" && ownerId !== claims.userId) {
            return json({ error: "Not your session" }, 403);
          }
        }

        // basename() keeps a crafted filename from escaping the session's keys.
        const filename = basename(decodeURIComponent(fileMatch[2]!));
        const store = await opts.objects();
        const key = objectKey(sessionId, filename);

        const object = await store.head(key);
        if (!object) return json({ error: "No such file" }, 404);

        const body = await store.get(key);
        if (!body) return json({ error: "No such file" }, 404);

        // inline so the console can show a purchase order in its viewer; the
        // type was decided when the file was stored, from its name.
        return new Response(body, {
          headers: {
            "content-type": contentTypeFor(filename),
            "content-length": String(object.size),
            "content-disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
            "cache-control": "private, max-age=300",
          },
        });
      }

      return json({ error: "Not found" }, 404);
    },

    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const session = manager.get(ws.data.sessionId);
        if (!session) {
          ws.close();
          return;
        }

        ws.send(JSON.stringify({ type: "session_status", status: session.status } as RobotEvent));
        // Whether frames are already flowing, so a client that reconnects to a
        // running session shows the true state of the preview rather than its
        // own freshly-mounted default.
        ws.send(
          JSON.stringify({
            type: "preview_state",
            enabled: session.previewEnabled,
          } as RobotEvent),
        );

        ws.data.unsubscribe = manager.subscribe(ws.data.sessionId, (event) => {
          ws.send(JSON.stringify(event));
        });
        // Preview frames ride the same socket as binary messages; clients tell
        // the two lanes apart by frame type, not by an envelope.
        ws.data.unsubscribeFrames = manager.subscribeFrames(ws.data.sessionId, (frame) => {
          ws.send(Buffer.from(frame, "base64"));
        });
      },

      message(ws: ServerWebSocket<SocketData>, raw) {
        let command: ClientCommand;
        try {
          command = JSON.parse(String(raw)) as ClientCommand;
        } catch {
          return;
        }

        const id = ws.data.sessionId;
        const session = manager.get(id);
        if (!session) return;
        if (!manager.canAccess(session, ws.data.claims.userId, ws.data.claims.role)) return;

        switch (command.type) {
          case "user_msg":
            manager.send(id, command.text);
            break;
          case "approval":
            manager.approve(id, command.requestId, command.approved);
            break;
          case "preview":
            void manager.setPreview(id, command.enabled);
            break;
          case "input":
            // Ownership, not canAccess: an admin watching a colleague's
            // sign-in must not be able to type into it.
            if (session.userId === ws.data.claims.userId) {
              void manager.dispatchInput(id, command.event);
            }
            break;
          case "stop":
            void manager.stop(id);
            break;
        }
      },

      close(ws: ServerWebSocket<SocketData>) {
        ws.data.unsubscribe?.();
        ws.data.unsubscribeFrames?.();
      },
    },
  });

  return {
    server,
    stop() {
      server.stop(true);
    },
  };
}
