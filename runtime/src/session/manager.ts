import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentRunner } from "../agent/runner";
import type { RobotBrowser } from "../browser/chromium";
import type { Store, TargetSite } from "../store";
import type { RobotEvent, SessionStatus } from "./events";

export type LaunchArgs = {
  targetUrl: string;
  user: { userId: string; email: string; role: string; name: string };
  sessionSecret: string;
  cookieName: string;
  downloadsDir: string;
};

export type AgentArgs = {
  cdpEndpoint: string;
  site: TargetSite;
  model: string;
  env: Record<string, string>;
  nodeBin?: string;
  onEvent: (event: RobotEvent) => void;
};

export type ScreencastStarter = (
  page: RobotBrowser["page"],
  onFrame: (jpegBase64: string) => void,
) => Promise<{ stop(): Promise<void> }>;

export type ManagerDeps = {
  launchBrowser: (args: LaunchArgs) => Promise<RobotBrowser>;
  startAgent: (args: AgentArgs) => Promise<AgentRunner>;
  startScreencast: ScreencastStarter;
  store: Store;
  now: () => number;
};

export type ManagerConfig = {
  downloadsRoot: string;
  env: Record<string, string>;
  nodeBin?: string;
};

export type Session = {
  id: string;
  userId: string;
  siteName: string;
  status: SessionStatus;
  startedAt: number;
  lastActivityAt: number;
  previewEnabled: boolean;
  browser: RobotBrowser;
  agent: AgentRunner;
  listeners: Set<(event: RobotEvent) => void>;
  frameListeners: Set<(frame: string) => void>;
  screencast?: { stop(): Promise<void> };
};

/** Thrown for conditions the caller should surface as a specific HTTP status. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown_user"
      | "unknown_site"
      | "no_site_account"
      | "site_limit"
      | "user_limit"
      | "global_limit"
      | "missing_secret",
  ) {
    super(message);
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private config: ManagerConfig,
    private deps: ManagerDeps,
  ) {}

  /**
   * Start a browser for `userId` against `siteProfileId`.
   *
   * Everything needed — the target URL, its signing secret, the identity to
   * assume, the concurrency policy — is resolved from the database, so adding a
   * site or raising a limit never requires a redeploy.
   */
  async create(userId: string, siteProfileId: string, title?: string): Promise<string> {
    const { store } = this.deps;

    const owner = await store.owner(userId);
    if (!owner) throw new SessionError("No such active user", "unknown_user");

    const site = await store.site(siteProfileId);
    if (!site) throw new SessionError("No such active site", "unknown_site");

    const settings = await store.settings();

    // Global before per-user: a full server is the more urgent message, and it
    // saves a second query when the answer is the same either way.
    if ((await store.liveSessionCount()) >= settings.globalSessionLimit) {
      throw new SessionError(
        `The server is running its maximum of ${settings.globalSessionLimit} browsers`,
        "global_limit",
      );
    }
    if ((await store.liveSessionCount(userId)) >= settings.perUserSessionLimit) {
      throw new SessionError(
        `You already have ${settings.perUserSessionLimit} browsers running`,
        "user_limit",
      );
    }

    const account = await store.siteAccount(userId, siteProfileId);
    if (!account) {
      throw new SessionError(
        `You have no account configured on ${site.name}`,
        "no_site_account",
      );
    }
    if (site.loginStrategy === "cookie_mint" && !site.secret) {
      throw new SessionError(`${site.name} has no signing secret configured`, "missing_secret");
    }

    const id = await store.createSession({ userId, siteProfileId, title });
    const downloadsDir = join(this.config.downloadsRoot, id);
    await mkdir(downloadsDir, { recursive: true }).catch(() => {});

    let browser: RobotBrowser;
    try {
      browser = await this.deps.launchBrowser({
        targetUrl: site.baseUrl,
        // The identity the target expects, not BrowserPilot's own user id.
        user: {
          userId: account.targetUserId,
          email: account.targetEmail,
          name: account.targetName,
          role: account.targetRole,
        },
        sessionSecret: site.secret ?? "",
        cookieName: site.cookieName,
        downloadsDir,
      });
    } catch (error) {
      await store.setStatus(id, "failed", `browser launch failed: ${(error as Error).message}`);
      throw error;
    }

    browser.onDownload((download) => {
      const filename = basename(download.suggestedFilename) || "download";
      void download
        .saveAs(join(downloadsDir, filename))
        .then(() =>
          this.handleEvent(id, {
            type: "file_ready",
            fileId: filename,
            filename,
            url: `/api/sessions/${id}/files/${encodeURIComponent(filename)}`,
          }),
        )
        .catch((error: Error) =>
          this.handleEvent(id, { type: "error", message: `Download failed: ${error.message}` }),
        );
    });

    let agent: AgentRunner;
    try {
      agent = await this.deps.startAgent({
        cdpEndpoint: browser.cdpEndpoint,
        site,
        model: settings.defaultModel,
        env: this.config.env,
        nodeBin: this.config.nodeBin,
        onEvent: (event) => this.handleEvent(id, event),
      });
    } catch (error) {
      await browser.close().catch(() => {});
      await store.setStatus(id, "failed", `agent start failed: ${(error as Error).message}`);
      throw error;
    }

    const now = this.deps.now();
    this.sessions.set(id, {
      id,
      userId,
      siteName: site.name,
      status: "idle",
      startedAt: now,
      lastActivityAt: now,
      previewEnabled: false,
      browser,
      agent,
      listeners: new Set(),
      frameListeners: new Set(),
    });

    await store.setStatus(id, "idle");
    return id;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Sessions a given user is allowed to see. Admins see everything. */
  listFor(userId: string, role: string): Session[] {
    return role === "ADMIN" ? this.list() : this.list().filter((s) => s.userId === userId);
  }

  canAccess(session: Session, userId: string, role: string): boolean {
    return role === "ADMIN" || session.userId === userId;
  }

  subscribe(id: string, listener: (event: RobotEvent) => void): () => void {
    const session = this.require(id);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  subscribeFrames(id: string, listener: (frame: string) => void): () => void {
    const session = this.require(id);
    session.frameListeners.add(listener);
    return () => session.frameListeners.delete(listener);
  }

  send(id: string, text: string): void {
    const session = this.require(id);
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.send(text);
  }

  approve(id: string, requestId: string, approved: boolean): void {
    const session = this.require(id);
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.approve(requestId, approved);
  }

  async setPreview(id: string, enabled: boolean): Promise<void> {
    const session = this.require(id);
    if (enabled === session.previewEnabled) return;
    session.previewEnabled = enabled;

    if (enabled) {
      session.screencast = await this.deps.startScreencast(session.browser.page, (frame) => {
        for (const listener of session.frameListeners) listener(frame);
      });
    } else {
      await session.screencast?.stop().catch(() => {});
      session.screencast = undefined;
    }
  }

  async stop(id: string, reason = "stopped by user"): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);

    await session.screencast?.stop().catch(() => {});
    session.screencast = undefined;
    this.emit(session, { type: "session_status", status: "stopped" });

    await session.agent.stop().catch(() => {});
    await session.browser.close().catch(() => {});
    await this.deps.store.setStatus(id, "stopped", reason).catch(() => {});
  }

  async sweep(): Promise<void> {
    const settings = await this.deps.store.settings();
    const now = this.deps.now();

    const expired = this.list().filter(
      (s) =>
        now - s.lastActivityAt > settings.idleTimeoutMs || now - s.startedAt > settings.hardCapMs,
    );

    await Promise.all(
      expired.map((s) =>
        this.stop(
          s.id,
          now - s.startedAt > settings.hardCapMs ? "maximum duration reached" : "idle timeout",
        ),
      ),
    );
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session ${id}`);
    return session;
  }

  private handleEvent(id: string, event: RobotEvent): void {
    const session = this.sessions.get(id);
    if (!session) return;

    session.lastActivityAt = this.deps.now();
    if (event.type === "approval_request") this.setStatus(session, "awaiting_approval");
    if (event.type === "error") this.setStatus(session, "failed");

    this.emit(session, event);

    // Persist for replay. Status changes are already written by setStatus, and
    // preview frames never come through here, so this stays cheap.
    void this.deps.store.appendEvent(id, event).catch(() => {});
  }

  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    this.emit(session, { type: "session_status", status });
    void this.deps.store.setStatus(session.id, status).catch(() => {});
  }

  private emit(session: Session, event: RobotEvent): void {
    for (const listener of session.listeners) listener(event);
  }
}
