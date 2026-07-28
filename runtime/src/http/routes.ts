import { join, basename } from "node:path";
import type { ServerWebSocket } from "bun";
import type { JwmUser } from "../auth/mint";
import type { ClientCommand, RobotEvent } from "../session/events";
import type { SessionManager } from "../session/manager";

type SocketData = {
  sessionId: string;
  unsubscribe?: () => void;
  unsubscribeFrames?: () => void;
};

export type ServerOptions = {
  port: number;
  debugUser: JwmUser;
  publicDir: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createServer(manager: SessionManager, opts: ServerOptions) {
  const server = Bun.serve<SocketData>({
    port: opts.port,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      const wsMatch = /^\/ws\/([^/]+)$/.exec(path);
      if (wsMatch) {
        const sessionId = wsMatch[1]!;
        if (!manager.get(sessionId)) return new Response("No such session", { status: 404 });
        if (srv.upgrade(req, { data: { sessionId } })) return undefined as unknown as Response;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      if (path === "/api/sessions" && req.method === "POST") {
        try {
          const id = await manager.create(opts.debugUser);
          return json({ id });
        } catch (error) {
          const message = (error as Error).message;
          return json({ error: message }, /limit/i.test(message) ? 429 : 500);
        }
      }

      if (path === "/api/sessions" && req.method === "GET") {
        return json({
          sessions: manager.list().map((s) => ({
            id: s.id,
            status: s.status,
            startedAt: s.startedAt,
            lastActivityAt: s.lastActivityAt,
          })),
        });
      }

      const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path);
      if (stopMatch && req.method === "POST") {
        const id = stopMatch[1]!;
        if (!manager.get(id)) return json({ error: "No such session" }, 404);
        await manager.stop(id);
        return json({ ok: true });
      }

      const fileMatch = /^\/api\/sessions\/([^/]+)\/files\/(.+)$/.exec(path);
      if (fileMatch && req.method === "GET") {
        const session = manager.get(fileMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
        // basename() keeps a crafted filename from escaping the session's dir.
        const file = Bun.file(join(session.browser.downloadsDir, basename(fileMatch[2]!)));
        if (!(await file.exists())) return json({ error: "No such file" }, 404);
        return new Response(file);
      }

      if (path === "/" || path === "/index.html") {
        return new Response(Bun.file(join(opts.publicDir, "debug.html")));
      }

      return new Response("Not found", { status: 404 });
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
        if (!manager.get(id)) return;

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
