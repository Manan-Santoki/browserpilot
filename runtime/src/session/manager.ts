import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentRunner } from "../agent/runner";
import type { RobotBrowser, SavedCookie } from "../browser/chromium";
import type { InputSink, RemoteInput } from "../browser/input";
import type { ScreencastOptions } from "../browser/screencast";
import { contentTypeFor } from "@browserpilot/core";
import { objectKey, type ObjectStore } from "../storage/object-store";
import type { ProfileStore } from "../browser/profiles";
import { looksSignedOut } from "./signed-out";
import type { Store, TargetSite } from "../store";
import { sessionFileUrl, type RobotEvent, type SessionStatus } from "./events";

export type LaunchArgs = {
  targetUrl: string;
  /** Cookies from an earlier sign-in, applied before the first navigation. */
  cookies?: SavedCookie[];
  /** Only for cookie_mint sites; a saved profile brings its own session. */
  user?: { userId: string; email: string; role: string; name: string };
  sessionSecret?: string;
  cookieName?: string;
  downloadsDir: string;
  profileDir?: string;
  skipNavigation?: boolean;
};

export type AgentArgs = {
  cdpEndpoint: string;
  site: TargetSite;
  model: string;
  env: Record<string, string>;
  nodeBin?: string;
  /** Named in the URLs the agent's screenshots are served from. */
  sessionId: string;
  /** Where those screenshots are written, alongside the session's downloads. */
  saveFile: (filename: string, bytes: Uint8Array) => Promise<void>;
  onEvent: (event: RobotEvent) => void;
};

/**
 * Takes the whole context, not one page: the agent opens and switches tabs, and
 * a stream pinned to a single page goes still the moment it moves on.
 */
export type ScreencastStarter = (
  context: RobotBrowser["context"],
  onFrame: (jpegBase64: string) => void,
  opts?: ScreencastOptions,
) => Promise<{ stop(): Promise<void> }>;

export type ManagerDeps = {
  launchBrowser: (args: LaunchArgs) => Promise<RobotBrowser>;
  startAgent: (args: AgentArgs) => Promise<AgentRunner>;
  startScreencast: ScreencastStarter;
  /** Saved logins, for sites we cannot mint a session into. */
  profiles: ProfileStore;
  /** Lets a person drive the browser themselves while signing in. */
  createInput: (page: RobotBrowser["page"]) => Promise<InputSink>;
  /** Where downloads are kept. Resolved per use so a settings change lands. */
  objects: () => Promise<ObjectStore>;
  store: Store;
  now: () => number;
};

/**
 * A sign-in stream is sent at the browser's own size and a high JPEG quality.
 * The default is tuned for a preview of the robot at work, where a soft frame
 * costs nothing; here a person has to read a form and click a small link.
 */
const LOGIN_SCREENCAST: ScreencastOptions = {
  quality: 92,
  maxWidth: 1600,
  maxHeight: 1600,
  fps: 15,
};

/**
 * Watching the robot work is now the larger half of the session page rather
 * than a thumbnail beside the chat, so the default 900px was being scaled up
 * and showing it. Still below the sign-in settings: this one runs for the whole
 * life of every session, where that one runs for a minute.
 */
const AGENT_SCREENCAST: ScreencastOptions = {
  quality: 80,
  maxWidth: 1600,
  maxHeight: 1600,
};

export type ManagerConfig = {
  downloadsRoot: string;
  /** Where a session's disposable copy of a saved profile is put. */
  scratchRoot: string;
  env: Record<string, string>;
  nodeBin?: string;
};

export type Session = {
  id: string;
  userId: string;
  siteProfileId: string;
  siteName: string;
  /** An agent session is driven by the robot; a login session by the person. */
  kind: "agent" | "login";
  status: SessionStatus;
  startedAt: number;
  lastActivityAt: number;
  previewEnabled: boolean;
  browser: RobotBrowser;
  /** Absent on a login session — nobody is instructing this browser. */
  agent?: AgentRunner;
  /** Present on a login session, which takes clicks and keystrokes. */
  input?: InputSink;
  /**
   * The disposable profile copy this session runs from, written back to the
   * saved login when the session ends cleanly.
   */
  scratchProfileDir?: string;
  listeners: Set<(event: RobotEvent) => void>;
  frameListeners: Set<(frame: string) => void>;
  screencast?: { stop(): Promise<void> };
  /**
   * The most recent frame, replayed to whoever connects next.
   *
   * A page that is not repainting produces nothing to send, so without this a
   * reload left the panel empty until the agent's next action — for a browser
   * sitting on a finished form, indefinitely.
   */
  lastFrame?: string;
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
      | "missing_secret"
      | "not_linked"
      | "login_expired",
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
  async create(
    userId: string,
    siteProfileId: string,
    title?: string,
    model?: string,
  ): Promise<string> {
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

    const usesSavedLogin = site.loginStrategy === "persistent_profile";

    if (!usesSavedLogin && !site.secret) {
      throw new SessionError(`${site.name} has no signing secret configured`, "missing_secret");
    }
    if (usesSavedLogin && account.linkState !== "linked") {
      throw new SessionError(
        account.linkState === "expired"
          ? `Your saved login for ${site.name} has expired — sign in again`
          : `Sign in to ${site.name} once before starting a session`,
        account.linkState === "expired" ? "login_expired" : "not_linked",
      );
    }

    const id = await store.createSession({ userId, siteProfileId, title });
    const downloadsDir = join(this.config.downloadsRoot, id);
    await mkdir(downloadsDir, { recursive: true }).catch(() => {});

    // A saved login runs from its own copy of the profile, so any number of
    // sessions for the same site can be open at once.
    let scratchProfileDir: string | undefined;
    if (usesSavedLogin) {
      scratchProfileDir = join(this.config.scratchRoot, id);
      try {
        await this.deps.profiles.checkout(siteProfileId, userId, scratchProfileDir);
      } catch {
        // No half-signed-in state: a profile that is gone means signing in
        // again, which is honest about what the site will see.
        await store.setLinkState(userId, siteProfileId, "none");
        await store.setStatus(id, "failed", "saved login is missing");
        throw new SessionError(
          `The saved login for ${site.name} is gone — sign in again`,
          "not_linked",
        );
      }
    }

    let browser: RobotBrowser;
    try {
      browser = await this.deps.launchBrowser({
        targetUrl: site.baseUrl,
        // The identity the target expects, not BrowserPilot's own user id.
        // A saved login already carries one, so nothing is minted for it.
        user: usesSavedLogin
          ? undefined
          : {
              userId: account.targetUserId ?? "",
              email: account.targetEmail ?? "",
              name: account.targetName ?? "",
              role: account.targetRole ?? "user",
            },
        sessionSecret: usesSavedLogin ? undefined : (site.secret ?? ""),
        cookieName: site.cookieName,
        downloadsDir,
        profileDir: scratchProfileDir,
        // Session cookies never reached the profile on disk; these did.
        cookies: usesSavedLogin ? (account.cookies ?? undefined) : undefined,
      });
    } catch (error) {
      await this.discardScratch(scratchProfileDir);
      await store.setStatus(id, "failed", `browser launch failed: ${(error as Error).message}`);
      throw error;
    }

    // The target answers the opening navigation by either showing the app or
    // bouncing to its sign-in page. The second means the saved login died.
    if (usesSavedLogin && looksSignedOut(browser.page.url(), site.loggedOutPattern)) {
      await browser.close().catch(() => {});
      await this.discardScratch(scratchProfileDir);
      await store.setLinkState(userId, siteProfileId, "expired");
      await store.setStatus(id, "failed", "saved login expired");
      throw new SessionError(
        `Your saved login for ${site.name} has expired — sign in again`,
        "login_expired",
      );
    }

    this.attachDownloads(id, browser, downloadsDir);

    let agent: AgentRunner;
    try {
      agent = await this.deps.startAgent({
        cdpEndpoint: browser.cdpEndpoint,
        site,
        // A per-session choice wins over the configured default; running
        // sessions keep whatever they started with.
        model: model?.trim() || settings.defaultModel,
        env: this.config.env,
        nodeBin: this.config.nodeBin,
        sessionId: id,
        saveFile: (filename, bytes) => this.storeBytes(id, downloadsDir, filename, bytes),
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
      siteProfileId,
      siteName: site.name,
      status: "idle",
      startedAt: now,
      lastActivityAt: now,
      previewEnabled: false,
      kind: "agent",
      browser,
      agent,
      scratchProfileDir,
      listeners: new Set(),
      frameListeners: new Set(),
    });

    await store.setStatus(id, "idle");
    return id;
  }

  /**
   * Open a browser for the person to sign in to a target site themselves.
   *
   * There is no agent here and no minted cookie: the browser starts empty at
   * the site's own front door, the preview is two-way, and whatever the login
   * leaves behind — cookies, local storage, service workers — stays in the
   * profile directory. `saveLogin` then makes that profile the saved one.
   *
   * Nothing typed during this session is recorded anywhere. It is a password.
   */
  async createLogin(userId: string, siteProfileId: string): Promise<string> {
    const { store } = this.deps;

    const owner = await store.owner(userId);
    if (!owner) throw new SessionError("No such active user", "unknown_user");

    const site = await store.site(siteProfileId);
    if (!site) throw new SessionError("No such active site", "unknown_site");

    const settings = await store.settings();
    if ((await store.liveSessionCount()) >= settings.globalSessionLimit) {
      throw new SessionError(
        `The server is running its maximum of ${settings.globalSessionLimit} browsers`,
        "global_limit",
      );
    }

    // Signing in again from a second tab would have two browsers writing one
    // profile; the newer attempt wins and the older one is closed.
    for (const existing of this.list()) {
      if (
        existing.kind === "login" &&
        existing.userId === userId &&
        existing.siteProfileId === siteProfileId
      ) {
        await this.stop(existing.id, "replaced by a newer sign-in");
      }
    }

    const profileDir = await this.deps.profiles.prepareForLogin(siteProfileId, userId);
    const id = await store.createSession({
      userId,
      siteProfileId,
      title: `Sign in to ${site.name}`,
      kind: "login",
    });

    const downloadsDir = join(this.config.downloadsRoot, id);
    await mkdir(downloadsDir, { recursive: true }).catch(() => {});

    let browser: RobotBrowser;
    try {
      browser = await this.deps.launchBrowser({
        targetUrl: site.baseUrl,
        downloadsDir,
        profileDir,
      });
    } catch (error) {
      await store.setStatus(id, "failed", `browser launch failed: ${(error as Error).message}`);
      throw error;
    }

    const input = await this.deps.createInput(browser.page);
    const now = this.deps.now();

    this.sessions.set(id, {
      id,
      userId,
      siteProfileId,
      siteName: site.name,
      kind: "login",
      status: "idle",
      startedAt: now,
      lastActivityAt: now,
      previewEnabled: false,
      browser,
      input,
      listeners: new Set(),
      frameListeners: new Set(),
    });

    // A login session is nothing but its preview, so it is never off.
    await this.setPreview(id, true);
    await store.setStatus(id, "idle");
    return id;
  }

  /**
   * Accept the login the person just performed.
   *
   * The browser is closed first: Chromium holds cookies and local storage in
   * memory and only flushes them to the profile on a clean shutdown, so saving
   * before closing would save a profile missing the very thing we want.
   */
  async saveLogin(id: string): Promise<void> {
    const session = this.require(id);
    if (session.kind !== "login") throw new Error("Not a sign-in session");

    // Read the cookies while the browser still holds them. Chromium writes the
    // ones with an expiry to the profile, but keeps session cookies in memory
    // and drops them on close — and a great many logins issue exactly those.
    const cookies = await session.browser.context.cookies().catch(() => []);

    this.sessions.delete(id);
    await session.screencast?.stop().catch(() => {});
    session.input?.close();
    await session.browser.close();

    if (cookies.length > 0) {
      await this.deps.store.saveCookies(session.userId, session.siteProfileId, cookies);
    }
    await this.deps.store.setLinkState(session.userId, session.siteProfileId, "linked");
    await this.deps.store.setStatus(id, "stopped", "signed in");
    this.emit(session, { type: "session_status", status: "stopped" });
  }

  /** Forward one click or keystroke from the person to the browser. */
  async dispatchInput(id: string, event: RemoteInput): Promise<void> {
    const session = this.require(id);
    if (session.kind !== "login" || !session.input) return;
    session.lastActivityAt = this.deps.now();
    await session.input.dispatch(event).catch(() => {
      // A dropped keystroke is not worth ending a sign-in over.
    });
  }

  /**
   * Put bytes the agent produced into the store under this session.
   *
   * Staged through a file because that is what the store takes — and because a
   * download arrives as one, so both paths end up identical.
   */
  private async storeBytes(
    sessionId: string,
    stagingDir: string,
    filename: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const safe = basename(filename) || "file";
    const staged = join(stagingDir, safe);

    await mkdir(stagingDir, { recursive: true }).catch(() => {});
    await Bun.write(staged, bytes);

    const store = await this.deps.objects();
    await store.put(objectKey(sessionId, safe), staged, contentTypeFor(safe));
    if (store.kind !== "local") await rm(staged, { force: true }).catch(() => {});
  }

  private async discardScratch(dir?: string): Promise<void> {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Take what the browser downloaded and put it somewhere it will outlive the
   * container. The browser can only write to a real path, so the file lands on
   * disk first and is handed to the store from there.
   */
  private attachDownloads(id: string, browser: RobotBrowser, downloadsDir: string): void {
    browser.onDownload((download) => {
      // basename() prevents a hostile suggested filename from escaping the dir.
      const filename = basename(download.suggestedFilename) || "download";
      const staged = join(downloadsDir, filename);

      void download
        .saveAs(staged)
        .then(async () => {
          const store = await this.deps.objects();
          await store.put(objectKey(id, filename), staged, contentTypeFor(filename));
          // Only once it is stored: a file the console cannot fetch should not
          // be announced as ready.
          if (store.kind !== "local") await rm(staged, { force: true }).catch(() => {});

          this.handleEvent(id, {
            type: "file_ready",
            fileId: filename,
            filename,
            url: sessionFileUrl(id, filename),
          });
        })
        .catch((error: Error) =>
          this.handleEvent(id, { type: "error", message: `Download failed: ${error.message}` }),
        );
    });
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
    // Paint immediately rather than making the newcomer wait for a repaint.
    if (session.lastFrame) listener(session.lastFrame);
    return () => session.frameListeners.delete(listener);
  }

  send(id: string, text: string): void {
    const session = this.require(id);
    if (!session.agent) return; // a sign-in session has nobody to instruct
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.send(text);

    // Written to the transcript but not emitted: the sender already rendered
    // it, and echoing would duplicate it on their screen.
    void this.deps.store.appendEvent(id, { type: "user_msg", text }).catch(() => {});
  }

  approve(id: string, requestId: string, approved: boolean): void {
    const session = this.require(id);
    if (!session.agent) return;
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.approve(requestId, approved);
  }

  async setPreview(id: string, enabled: boolean): Promise<void> {
    const session = this.require(id);
    if (enabled === session.previewEnabled) return;
    session.previewEnabled = enabled;

    if (enabled) {
      session.screencast = await this.deps.startScreencast(session.browser.context, (frame) => {
        session.lastFrame = frame;
        for (const listener of session.frameListeners) listener(frame);
      });
    } else {
      await session.screencast?.stop().catch(() => {});
      session.screencast = undefined;
    }

    this.emit(session, { type: "preview_state", enabled });
  }

  /**
   * Replace a session's browser without ending the session.
   *
   * The agent keeps its conversation, but everything it had on screen is gone —
   * it lands back on the target's home page, freshly authenticated. Use when a
   * page has wedged or the browser has drifted somewhere unrecoverable.
   */
  async restartBrowser(id: string): Promise<void> {
    const session = this.require(id);
    if (session.kind !== "agent" || !session.agent) {
      throw new Error("Only a robot session has a browser to restart");
    }
    const site = await this.deps.store.site(session.siteProfileId);
    if (!site) throw new SessionError("The site is no longer available", "unknown_site");

    const account = await this.deps.store.siteAccount(session.userId, session.siteProfileId);
    if (!account) throw new SessionError("You have no account on this site", "no_site_account");

    const wasPreviewing = session.previewEnabled;
    await session.screencast?.stop().catch(() => {});
    session.screencast = undefined;
    session.previewEnabled = false;
    // The cached frame shows a browser that is about to stop existing.
    session.lastFrame = undefined;

    const usesSavedLogin = site.loginStrategy === "persistent_profile";
    const old = session.browser;

    // A saved-login site gets a fresh copy of the profile, so the restarted
    // browser is logged in the same way the original one was.
    if (usesSavedLogin && session.scratchProfileDir) {
      await old.close().catch(() => {});
      await this.discardScratch(session.scratchProfileDir);
      await this.deps.profiles.checkout(
        session.siteProfileId,
        session.userId,
        session.scratchProfileDir,
      );
    }

    session.browser = await this.deps.launchBrowser({
      targetUrl: site.baseUrl,
      user: usesSavedLogin
        ? undefined
        : {
            userId: account.targetUserId ?? "",
            email: account.targetEmail ?? "",
            name: account.targetName ?? "",
            role: account.targetRole ?? "user",
          },
      sessionSecret: usesSavedLogin ? undefined : (site.secret ?? ""),
      cookieName: site.cookieName,
      downloadsDir: join(this.config.downloadsRoot, id),
      profileDir: session.scratchProfileDir,
      cookies: usesSavedLogin ? (account.cookies ?? undefined) : undefined,
    });
    if (!usesSavedLogin) await old.close().catch(() => {});

    this.attachDownloads(id, session.browser, join(this.config.downloadsRoot, id));

    // The agent still holds tools pointed at the old browser's debugging port,
    // so it must be told rather than left to discover the failure mid-task.
    session.agent?.send(
      "Your browser was restarted and is back on the home page. Anything you had open is gone — take a fresh snapshot before continuing.",
    );

    this.handleEvent(id, {
      type: "tool_activity",
      tool: "browser_restart",
      summary: "Browser restarted — back on the home page",
    });

    if (wasPreviewing) await this.setPreview(id, true);
  }

  async stop(id: string, reason = "stopped by user"): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);

    await session.screencast?.stop().catch(() => {});
    session.screencast = undefined;
    session.input?.close();
    this.emit(session, { type: "session_status", status: "stopped" });

    // Same reason as saveLogin: read the cookies before the browser goes away,
    // so a target that rotated its session token during this session is
    // remembered rather than left behind with the copy.
    const freshCookies = session.scratchProfileDir
      ? await session.browser.context.cookies().catch(() => [])
      : [];

    await session.agent?.stop().catch(() => {});
    await session.browser.close().catch(() => {});

    // Sites that hand out a new session token on every request would otherwise
    // expire the moment this copy was thrown away, so a cleanly finished
    // session writes what it learned back to the saved login. The browser is
    // already closed, so its state is on disk to be copied.
    if (session.scratchProfileDir) {
      await this.deps.profiles
        .syncBack(session.siteProfileId, session.userId, session.scratchProfileDir)
        .then(async () => {
          if (freshCookies.length > 0) {
            await this.deps.store.saveCookies(session.userId, session.siteProfileId, freshCookies);
          }
          await this.deps.store.markSynced(session.userId, session.siteProfileId);
        })
        .catch(() => {
          // The saved login simply stays as it was.
        });
      await this.discardScratch(session.scratchProfileDir);
    }

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
