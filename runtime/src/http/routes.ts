import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { verifyTicket, type TicketClaims } from "@browserpilot/core";
import type { ClientCommand, RobotEvent } from "../session/events";
import { SessionError, type SessionManager } from "../session/manager";
import type { Store } from "../store";
import { contentTypeFor } from "@browserpilot/core";
import { objectKey, type ObjectStore } from "../storage/object-store";
import { describeStorage, type StorageEnv } from "../storage/settings";
import {
  describeProviderSettings,
  formatForModel,
  type ProviderEnv,
} from "../agent/provider-settings";
import { checkProvider } from "../agent/preflight";
import { resolveModel } from "@browserpilot/core";

type SocketData = {
  sessionId: string;
  claims: TicketClaims;
  /** Set when the client asked for frames as base64 text rather than binary. */
  base64Frames?: boolean;
  unsubscribe?: () => void;
  unsubscribeFrames?: () => void;
};

export type ServerOptions = {
  port: number;
  ticketSecret: string;
  store: Store;
  /** Where session downloads are kept. */
  objects: () => Promise<ObjectStore>;
  /** The storage variables this deployment was started with. */
  storageEnv: StorageEnv;
  /** The provider variables this deployment was started with. */
  providerEnv: ProviderEnv;
  /** Where per-session download directories live. */
  downloadsRoot: string;
};

/**
 * How much unsent frame data may sit in a socket before frames start being
 * dropped. About one large frame: enough to ride out a hiccup, not enough to
 * build a delay anyone would notice.
 */
const FRAME_BACKLOG_BYTES = 1_500_000;

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
  unknown_session: 404,
  not_resumable: 409,
  // Nothing the caller did wrong, and retrying will not help until an
  // administrator configures a provider.
  no_provider: 503,
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
        if (!(await manager.canView(session, claims.userId, claims.role, claims.perms))) {
          return json({ error: "Not your session" }, 403);
        }
        // Declared in the URL rather than in a message, because the first
        // frame is replayed the moment the socket opens — before any message
        // from the client could have arrived. A client that asked afterwards
        // silently missed that frame, which on a still page is the only one
        // it was going to get.
        const wantsBase64 = url.searchParams.get("frames") === "base64";

        if (srv.upgrade(req, { data: { sessionId, claims, base64Frames: wantsBase64 } })) {
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

        if (claims.role !== "ADMIN" && !claims.perms?.includes("session.start")) {
          return json({ error: "You do not have permission to start sessions" }, 403);
        }

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

      // Read-only, admin-only: what the runtime resolved storage to, so the
      // console can state it rather than restate the configuration it sent.
      if (path === "/api/storage" && req.method === "GET") {
        if (claims.role !== "ADMIN") return json({ error: "Administrators only" }, 403);

        const settings = await opts.store.storageSettings(opts.storageEnv);
        const store = await opts.objects();

        // Prove it end to end rather than describe intent: write a small object,
        // read it back, remove it. A misconfigured bucket fails here, not on
        // someone's download.
        let reachable = false;
        let error: string | undefined;
        const probeKey = "sessions/_healthcheck/probe.txt";
        try {
          const staged = join(tmpdir(), `bp-storage-probe-${Date.now()}`);
          await Bun.write(staged, "ok");
          await store.put(probeKey, staged, "text/plain");
          reachable = (await store.head(probeKey)) !== undefined;
          await store.delete(probeKey).catch(() => {});
          await rm(staged, { force: true }).catch(() => {});
        } catch (e) {
          error = (e as Error).message;
        }

        return json({ ...describeStorage(settings), reachable, error });
      }

      // The same shape of answer for the model provider: what the runtime
      // would use for the *next* session, proven against the provider rather
      // than described. `?model=` probes one entry of the catalogue; without
      // it, the deployment default.
      if (path === "/api/provider" && req.method === "GET") {
        if (claims.role !== "ADMIN") return json({ error: "Administrators only" }, 403);

        const settings = await opts.store.providerSettings(opts.providerEnv);
        const described = describeProviderSettings(settings);
        if (!settings) return json(described);

        const requested = url.searchParams.get("model")?.trim();
        const model = resolveModel({
          requested,
          fallback: (await opts.store.settings()).defaultModel,
          catalogue: settings.models,
        });
        if (!model) return json({ ...described, reachable: false, error: "No model to check" });

        const check = await checkProvider(
          { ...settings, format: formatForModel(settings, model) },
          model,
          { timeoutMs: 10_000 },
        );

        return json({
          ...described,
          model,
          reachable: check.ok,
          rateLimited: check.ok ? Boolean(check.rateLimited) : false,
          latencyMs: check.ok ? check.latencyMs : undefined,
          error: check.ok ? undefined : check.detail,
        });
      }

      if (path === "/api/sessions" && req.method === "GET") {
        return json({
          sessions: (await manager.listFor(claims.userId, claims.role, claims.perms)).map((s) => ({
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
          const canStop =
            claims.role === "ADMIN" ||
            claims.perms?.includes("session.stop_others") ||
            owner === claims.userId;
          if (!canStop) return json({ error: "Not your session" }, 403);
          const cleared = await opts.store.forceStop(id, "browser was already gone");
          return json({ ok: true, cleared });
        }

        if (
          !manager.canControl(session, claims.userId, claims.role) &&
          !claims.perms?.includes("session.stop_others")
        ) {
          return json({ error: "Not your session" }, 403);
        }
        await manager.stop(session.id);
        return json({ ok: true });
      }

      const restartMatch = /^\/api\/sessions\/([^/]+)\/restart$/.exec(path);
      if (restartMatch && req.method === "POST") {
        const session = manager.get(restartMatch[1]!);
        if (!session) return json({ error: "No such session" }, 404);
        if (!manager.canControl(session, claims.userId, claims.role)) {
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

      const resumeMatch = /^\/api\/sessions\/([^/]+)\/resume$/.exec(path);
      if (resumeMatch && req.method === "POST") {
        const sourceId = resumeMatch[1]!;
        const source = await opts.store.resumableSession(sourceId);
        if (!source) return json({ error: "No such session" }, 404);
        if (claims.role !== "ADMIN" && source.userId !== claims.userId) {
          return json({ error: "Not your session" }, 403);
        }

        try {
          const id = await manager.resume(sourceId);
          return json({ id, resumedFromSessionId: sourceId });
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
        const live = manager.get(sessionId);
        if (live) {
          if (!(await manager.canView(live, claims.userId, claims.role, claims.perms))) {
            return json({ error: "Not your session" }, 403);
          }
        } else {
          const ownerId = await opts.store.sessionOwner(sessionId);
          if (!ownerId) return json({ error: "No such session" }, 404);
          if (claims.role !== "ADMIN" && ownerId !== claims.userId) {
            return json({ error: "Not your session" }, 403);
          }
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
          if (!(await manager.canView(live, claims.userId, claims.role, claims.perms))) {
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
          // Drop rather than queue. A frame is only worth sending while it is
          // still what the browser looks like; behind a slow connection a queue
          // turns into a growing delay, and the viewer watches the past — which
          // reads as the stream being broken rather than merely slower.
          if (ws.getBufferedAmount() > FRAME_BACKLOG_BYTES) return;

          // The frame is already base64 on the way in, so text costs the
          // runtime less than binary — it is the wire that pays, not us.
          if (ws.data.base64Frames) {
            ws.send(JSON.stringify({ type: "frame", data: frame }));
            return;
          }
          ws.send(Buffer.from(frame, "base64"));
        });
      },

      async message(ws: ServerWebSocket<SocketData>, raw) {
        let command: ClientCommand;
        try {
          command = JSON.parse(String(raw)) as ClientCommand;
        } catch {
          return;
        }

        const id = ws.data.sessionId;
        const session = manager.get(id);
        if (!session) return;
        // Reading a session — its transcript, its frames — is what sharing and
        // `session.view_others` grant. Writes below are gated harder.
        if (!(await manager.canView(session, ws.data.claims.userId, ws.data.claims.role, ws.data.claims.perms))) {
          return;
        }
        const mayControl = manager.canControl(session, ws.data.claims.userId, ws.data.claims.role);
        const perms = ws.data.claims.perms ?? [];

        switch (command.type) {
          case "user_msg":
            if (mayControl) manager.send(id, command.text);
            break;
          case "voice_task_start":
            if (mayControl) manager.startVoiceTask(id, command.requestId, command.text);
            break;
          case "agent_interrupt":
            if (mayControl) void manager.interruptVoiceTask(id, command.requestId);
            break;
          case "approval":
            // An admin or the owner always decides; `session.approve` lets a
            // watcher answer an approval on a shared session.
            if (mayControl || perms.includes("session.approve")) {
              manager.approve(id, command.requestId, command.approved);
            }
            break;
          case "choice":
            if (mayControl) manager.choose(id, command.requestId, command.value);
            break;
          case "preview":
            void manager.setPreview(id, command.enabled);
            break;
          case "frame_encoding":
            ws.data.base64Frames = command.encoding === "base64";
            break;
          case "viewport":
            void manager.setPreviewSize(id, command.cssWidth, command.pixelRatio);
            break;
          case "input":
            // Ownership, not canAccess: an admin watching a colleague's
            // sign-in must not be able to type into it.
            if (session.userId === ws.data.claims.userId) {
              void manager.dispatchInput(id, command.event);
            }
            break;
          case "stop":
            if (mayControl || perms.includes("session.stop_others")) void manager.stop(id);
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
