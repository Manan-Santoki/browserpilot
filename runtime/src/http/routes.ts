import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { verifyTicket, type TicketClaims } from "@browserpilot/core";
import type { ClientCommand, RobotEvent } from "../session/events";
import { SessionError, type SessionManager } from "../session/manager";
import type { Store } from "../store";

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

      const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path);
      if (stopMatch && req.method === "POST") {
        const session = manager.get(stopMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
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

      const fileMatch = /^\/api\/sessions\/([^/]+)\/files\/(.+)$/.exec(path);
      if (fileMatch && req.method === "GET") {
        const session = manager.get(fileMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
        if (!manager.canAccess(session, claims.userId, claims.role)) {
          return json({ error: "Not your session" }, 403);
        }
        // basename() keeps a crafted filename from escaping the session's dir.
        const file = Bun.file(join(session.browser.downloadsDir, basename(fileMatch[2]!)));
        if (!(await file.exists())) return json({ error: "No such file" }, 404);
        return new Response(file);
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
