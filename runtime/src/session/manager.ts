import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentRunner } from "../agent/runner";
import type { RobotBrowser, SavedCookie } from "../browser/chromium";
import type { InputSink, RemoteInput } from "../browser/input";
import type { ScreencastOptions } from "../browser/screencast";
import { agentProviderOptions, type ProviderSettings } from "../agent/provider-settings";
import { resolveModel, type WireFormat } from "@browserpilot/core";
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
  /**
   * How to reach the provider, and what this particular model can accept.
   * Produced by `agentProviderOptions` so the two engines cannot disagree.
   */
  env: Record<string, string>;
  format?: WireFormat;
  vision?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
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
) => Promise<{ stop(): Promise<void>; resize(cssWidth: number, pixelRatio: number): void }>;

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
  /**
   * Which Messages API the agent talks to. Resolved per session for the same
   * reason downloads are: an administrator switching provider in the console
   * should take effect on the next session, not the next redeploy.
   */
  resolveProvider: () => Promise<ProviderSettings | null>;
  store: Store;
  now: () => number;
};

/**
 * Signing in is the one time a person is aiming at things themselves, so the
 * moving stream is worth more here than while watching the robot: a cursor
 * that lags is a cursor that misses. The still frame is sharp in both cases.
 */
const LOGIN_SCREENCAST: ScreencastOptions = {
  quality: 80,
  fps: 20,
  settleMs: 250,
};

/**
 * Watching the robot work. The defaults already carry the motion cheaply and
 * the sharp frame is sized from the viewer's own panel, so there is nothing
 * left to say here — which is the point.
 */
const AGENT_SCREENCAST: ScreencastOptions = {};

export type ManagerConfig = {
  downloadsRoot: string;
  /** Where a session's disposable copy of a saved profile is put. */
  scratchRoot: string;
  nodeBin?: string;
};

type Continuation = {
  sourceSessionId: string;
  targetUrl?: string;
  lastUserMessage?: string;
  handoff: string;
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
  /** The model is fixed for the lifetime of an agent session. */
  model?: string;
  /** Most recent request, used once if an in-progress browser must be recovered. */
  lastUserMessage?: string;
  /** Prevents an intentional close during replacement from starting another replacement. */
  restartingBrowser?: boolean;
  /** Caps automatic recovery so a broken host cannot spin Chromium forever. */
  automaticBrowserRestarts?: number;
  /** Absent on a login session — nobody is instructing this browser. */
  agent?: AgentRunner;
  /** Gemini function call currently delegated to Claude, if any. */
  activeVoiceTaskId?: string;
  /** Small idempotency cache so a retried Live API call cannot run twice. */
  voiceCommandResults: Map<string, Extract<RobotEvent, { type: "voice_command_result" }>>;
  /** Present on a login session, which takes clicks and keystrokes. */
  input?: InputSink;
  /**
   * The disposable profile copy this session runs from, written back to the
   * saved login when the session ends cleanly.
   */
  scratchProfileDir?: string;
  listeners: Set<(event: RobotEvent) => void>;
  frameListeners: Set<(frame: string) => void>;
  /** Durable writes that a clean stop flushes before resume reads the handoff. */
  pendingWrites: Set<Promise<void>>;
  screencast?: { stop(): Promise<void>; resize(cssWidth: number, pixelRatio: number): void };
  /** Remembered so a restarted stream comes back at the right size. */
  previewSize?: { cssWidth: number; pixelRatio: number };
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
      | "login_expired"
      | "unknown_session"
      | "not_resumable"
      | "no_provider",
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

  /** One transient Chromium spawn failure should not fail the whole session. */
  private async launchBrowserWithRetry(args: LaunchArgs): Promise<RobotBrowser> {
    try {
      return await this.deps.launchBrowser(args);
    } catch {
      await Bun.sleep(250);
      return this.deps.launchBrowser(args);
    }
  }

  /** Never let a stale or crafted checkpoint move a resumed browser to another origin. */
  private safeContinuationUrl(baseUrl: string, candidate?: string): string {
    if (!candidate) return baseUrl;
    try {
      const base = new URL(baseUrl);
      const target = new URL(candidate);
      return target.origin === base.origin ? target.toString() : baseUrl;
    } catch {
      return baseUrl;
    }
  }

  /** Compact durable history into a handoff small enough to be useful to the new agent. */
  private resumeHandoff(lastUserMessage: string | null, events: RobotEvent[]): string {
    const lines = events.flatMap((event): string[] => {
      if (event.type === "user_msg") return [`User: ${event.text.slice(0, 1_200)}`];
      if (event.type === "agent_text") return [`Assistant: ${event.text.slice(0, 1_200)}`];
      if (event.type === "tool_activity") {
        return [`Recorded tool attempt: ${event.summary.slice(0, 500)}`];
      }
      if (event.type === "file_ready") return [`File already produced: ${event.filename}`];
      if (event.type === "choice_resolved") return [`User selected: ${event.label}`];
      if (event.type === "error") return [`Previous error: ${event.message.slice(0, 500)}`];
      return [];
    });

    // Keep the end, where the interrupted work and latest user intent live.
    let history = lines.slice(-30).join("\n");
    if (history.length > 6_000) history = history.slice(history.length - 6_000);
    const request =
      lastUserMessage ??
      [...events].reverse().find((event) => event.type === "user_msg")?.text ??
      "No unfinished request was recorded.";

    return [
      "BrowserPilot resumed an ended session in a fresh browser.",
      "First take a fresh snapshot and reconcile the current page with the history below.",
      "Treat the history as context only. Do not repeat a submission, destructive action, approval, purchase, message, or download merely because it appears there.",
      "No pending approval carries over. If a consequential action may already have happened or the state is ambiguous, ask the user before acting.",
      "If the latest request is unfinished, continue it from the verified current state. If it is already complete, briefly report that and wait.",
      `Latest recorded user request: ${request.slice(0, 1_500)}`,
      history ? `Recent session history:\n${history}` : "No transcript was recorded.",
    ].join("\n\n");
  }

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
    continuation?: Continuation,
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

    // Resolved against the live catalogue rather than taken on trust: a model
    // an administrator has since removed would otherwise 404 on the first
    // turn, and the person who picked it would have no way to know why.
    const provider = await this.deps.resolveProvider();
    if (!provider) {
      throw new SessionError(
        "No model provider is configured — an administrator needs to set one up",
        "no_provider",
      );
    }

    const selectedModel = resolveModel({
      requested: model,
      preferred: owner.preferredModel,
      fallback: settings.defaultModel,
      catalogue: provider.models,
    });
    if (!selectedModel) {
      throw new SessionError("No model is available to run this session", "no_provider");
    }
    const targetUrl = this.safeContinuationUrl(site.baseUrl, continuation?.targetUrl);
    const id = await store.createSession({
      userId,
      siteProfileId,
      title,
      model: selectedModel,
      resumedFromSessionId: continuation?.sourceSessionId,
      lastUrl: targetUrl,
      lastUserMessage: continuation?.lastUserMessage,
    });
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
      browser = await this.launchBrowserWithRetry({
        targetUrl,
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

    let agent: AgentRunner;
    try {
      agent = await this.deps.startAgent({
        cdpEndpoint: browser.cdpEndpoint,
        site,
        // A per-session choice wins over the configured default; running
        // sessions keep whatever they started with.
        model: selectedModel,
        ...agentProviderOptions(provider, selectedModel),
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
    this.attachDownloads(
      id,
      browser,
      downloadsDir,
      (filename) => agent.downloadDetected(filename),
      (filename) => agent.downloadCompleted(filename),
    );

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
      model: selectedModel,
      automaticBrowserRestarts: 0,
      lastUserMessage: continuation?.lastUserMessage,
      scratchProfileDir,
      listeners: new Set(),
      frameListeners: new Set(),
      pendingWrites: new Set(),
      voiceCommandResults: new Map(),
    });
    this.watchBrowser(id, browser);

    await store.setStatus(id, "idle");
    await store
      .checkpointSession(id, { lastUrl: browser.page.url() })
      .catch(() => {});

    if (continuation) {
      this.handleEvent(id, {
        type: "tool_activity",
        tool: "session_resume",
        summary: "Continued from the previous session in a fresh browser",
      });
      this.setStatus(this.require(id), "working");
      agent.send(continuation.handoff);
    }

    return id;
  }

  /**
   * Continue a terminal robot run in a new browser.
   *
   * The old row and transcript remain untouched. A bounded handoff gives the
   * new agent enough context to reconcile the current site state without
   * blindly replaying a click, approval, form submission, or download.
   */
  async resume(sourceSessionId: string): Promise<string> {
    const source = await this.deps.store.resumableSession(sourceSessionId);
    if (!source) throw new SessionError("No such session", "unknown_session");
    if (
      source.kind !== "agent" ||
      !source.siteProfileId ||
      !["stopped", "failed", "interrupted"].includes(source.status)
    ) {
      throw new SessionError("Only an ended robot session can be resumed", "not_resumable");
    }
    const existingContinuation = await this.deps.store.continuationFor(source.id);
    if (existingContinuation) {
      throw new SessionError(
        "This session has already been continued. Open its continuation instead.",
        "not_resumable",
      );
    }

    const stored = await this.deps.store.events(source.id);
    const handoff = this.resumeHandoff(source.lastUserMessage, stored.map((row) => row.payload));

    return this.create(
      source.userId,
      source.siteProfileId,
      source.title ?? undefined,
      source.model ?? undefined,
      {
        sourceSessionId: source.id,
        targetUrl: source.lastUrl ?? undefined,
        lastUserMessage: source.lastUserMessage ?? undefined,
        handoff,
      },
    );
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
      browser = await this.launchBrowserWithRetry({
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
      pendingWrites: new Set(),
      voiceCommandResults: new Map(),
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
  private attachDownloads(
    id: string,
    browser: RobotBrowser,
    downloadsDir: string,
    onDetected?: (filename: string) => void,
    onReady?: (filename: string) => void,
  ): void {
    browser.onDownload((download) => {
      // basename() prevents a hostile suggested filename from escaping the dir.
      const filename = basename(download.suggestedFilename) || "download";
      const staged = join(downloadsDir, filename);
      // The download event fires as soon as Chromium accepts it. Block another
      // click immediately, while the bytes finish moving into durable storage.
      onDetected?.(filename);

      void download
        .saveAs(staged)
        .then(async () => {
          const store = await this.deps.objects();
          await store.put(objectKey(id, filename), staged, contentTypeFor(filename));
          // Only once it is stored: a file the console cannot fetch should not
          // be announced as ready.
          if (store.kind !== "local") await rm(staged, { force: true }).catch(() => {});

          onReady?.(filename);
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

  /**
   * Sessions a given user is allowed to see: their own, everyone's for an
   * admin, anything granted by `session.view_others`, and what was shared with
   * them.
   */
  async listFor(
    userId: string,
    role: string,
    perms?: string[],
  ): Promise<Session[]> {
    if (role === "ADMIN") return this.list();
    const visible: Session[] = [];
    for (const session of this.list()) {
      if (await this.canView(session, userId, role, perms)) visible.push(session);
    }
    return visible;
  }

  /**
   * Whether this user may operate a session — the owner, or an admin. A
   * viewer, however legitimately granted read access, must not be able to type,
   * approve, or stop.
   */
  canControl(session: Session, userId: string, role: string): boolean {
    return role === "ADMIN" || session.userId === userId;
  }

  /**
   * Whether this user may watch a session: the owner, an admin, someone with
   * the `session.view_others` permission, or someone the owner shared it with.
   */
  async canView(session: Session, userId: string, role: string, perms?: string[]): Promise<boolean> {
    if (this.canControl(session, userId, role)) return true;
    if (perms?.includes("session.view_others")) return true;
    return this.deps.store.isShared(session.id, userId);
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
    session.lastUserMessage = text;
    session.agent.send(text);

    // Written to the transcript but not emitted: the sender already rendered
    // it, and echoing would duplicate it on their screen.
    this.persist(session, () =>
      this.deps.store.appendEvent(
        id,
        { type: "user_msg", text },
        { lastUrl: session.browser.page.url(), lastUserMessage: text },
      ),
    );
  }

  /**
   * Delegate one Gemini Live function call to Claude.
   *
   * The acknowledgement is emitted synchronously so Gemini's blocking
   * function call can finish immediately while Claude continues over the
   * existing event stream.
   */
  startVoiceTask(id: string, requestId: string, text: string): void {
    const session = this.require(id);
    const cached = session.voiceCommandResults.get(requestId);
    if (cached) {
      this.emit(session, cached);
      return;
    }

    const instruction = text.trim();
    if (
      !session.agent ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId) ||
      instruction.length === 0 ||
      instruction.length > 4_000
    ) {
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "start",
        ok: false,
        status: "invalid",
        message: "The voice task was not valid for this session.",
      });
      return;
    }

    if (
      session.activeVoiceTaskId ||
      session.status === "working" ||
      session.status === "awaiting_approval" ||
      session.status === "starting"
    ) {
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "start",
        ok: false,
        status: "busy",
        message: "Claude is already working. Wait, or explicitly interrupt the current task.",
      });
      return;
    }

    session.activeVoiceTaskId = requestId;
    session.lastActivityAt = this.deps.now();
    session.lastUserMessage = instruction;
    this.setStatus(session, "working");
    session.agent.send(instruction, requestId);

    const userEvent: RobotEvent = {
      type: "user_msg",
      text: instruction,
      voiceTaskId: requestId,
    };
    // A spoken request has no local composer bubble, so every connected client
    // needs the echo from the runtime.
    this.emit(session, userEvent);
    this.persist(session, () =>
      this.deps.store.appendEvent(id, userEvent, {
        lastUrl: session.browser.page.url(),
        lastUserMessage: instruction,
      }),
    );

    this.finishVoiceCommand(session, {
      type: "voice_command_result",
      requestId,
      action: "start",
      ok: true,
      status: "accepted",
      message: "Claude accepted the browser task and is working on it.",
      voiceTaskId: requestId,
    });
  }

  /** Interrupt the active Claude turn without closing its reusable session. */
  async interruptVoiceTask(id: string, requestId: string): Promise<void> {
    const session = this.require(id);
    const cached = session.voiceCommandResults.get(requestId);
    if (cached) {
      this.emit(session, cached);
      return;
    }

    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId) || !session.agent) {
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "interrupt",
        ok: false,
        status: "invalid",
        message: "There is no browser agent to interrupt.",
      });
      return;
    }

    if (
      !session.activeVoiceTaskId &&
      session.status !== "working" &&
      session.status !== "awaiting_approval"
    ) {
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "interrupt",
        ok: false,
        status: "idle",
        message: "Claude is not currently running a browser task.",
      });
      return;
    }

    const interruptedTaskId = session.activeVoiceTaskId;
    session.activeVoiceTaskId = undefined;
    try {
      await session.agent.interrupt();
      this.setStatus(session, "idle");
      if (interruptedTaskId) {
        this.emit(session, {
          type: "agent_turn_complete",
          outcome: "interrupted",
          voiceTaskId: interruptedTaskId,
        });
      }
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "interrupt",
        ok: true,
        status: "accepted",
        message: "Claude stopped the current browser task.",
      });
    } catch (error) {
      this.finishVoiceCommand(session, {
        type: "voice_command_result",
        requestId,
        action: "interrupt",
        ok: false,
        status: "failed",
        message: `Claude could not be interrupted: ${(error as Error).message}`,
      });
    }
  }

  private finishVoiceCommand(
    session: Session,
    event: Extract<RobotEvent, { type: "voice_command_result" }>,
  ): void {
    console.info(
      JSON.stringify({
        component: "live_voice",
        event: `browser_task.${event.action}`,
        sessionId: session.id,
        requestId: event.requestId,
        ok: event.ok,
        status: event.status,
      }),
    );
    session.voiceCommandResults.set(event.requestId, event);
    while (session.voiceCommandResults.size > 64) {
      const oldest = session.voiceCommandResults.keys().next().value as string | undefined;
      if (!oldest) break;
      session.voiceCommandResults.delete(oldest);
    }
    this.emit(session, event);
  }

  approve(id: string, requestId: string, approved: boolean): void {
    const session = this.require(id);
    if (!session.agent) return;
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.approve(requestId, approved);
  }

  choose(id: string, requestId: string, value: string): void {
    const session = this.require(id);
    if (!session.agent) return;
    session.lastActivityAt = this.deps.now();
    this.setStatus(session, "working");
    session.agent.choose(requestId, value);
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

  /** Tell the running stream how large the viewer is showing it. */
  async setPreviewSize(id: string, cssWidth: number, pixelRatio: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.previewSize = { cssWidth, pixelRatio };
    session.screencast?.resize(cssWidth, pixelRatio);
  }

  /** Watch the exact browser instance so a later replacement ignores its close event. */
  private watchBrowser(id: string, browser: RobotBrowser): void {
    browser.onClose(() => {
      const session = this.sessions.get(id);
      if (
        !session ||
        session.kind !== "agent" ||
        session.browser !== browser ||
        session.restartingBrowser
      ) {
        return;
      }

      const attempts = session.automaticBrowserRestarts ?? 0;
      if (attempts >= 2) {
        this.handleEvent(id, {
          type: "error",
          message:
            "The browser exited repeatedly and could not stay running. Check the runtime host resources, then restart the session.",
        });
        return;
      }

      session.automaticBrowserRestarts = attempts + 1;
      void this.replaceBrowser(id, true).catch((error) => {
        if (!this.sessions.has(id)) return;
        this.handleEvent(id, {
          type: "error",
          message: `Could not recover the browser: ${(error as Error).message}`,
        });
      });
    });
  }

  /**
   * Replace both Chromium and the agent connected to its debugging port.
   *
   * A Playwright MCP process is permanently bound to the CDP endpoint it
   * started with. Replacing Chromium alone leaves the agent talking to a dead
   * port, which is why the old Restart button appeared to work but every tool
   * still returned ECONNREFUSED.
   */
  async restartBrowser(id: string): Promise<void> {
    const session = this.require(id);
    session.automaticBrowserRestarts = 0;
    await this.replaceBrowser(id, false);
  }

  private async replaceBrowser(id: string, automatic: boolean): Promise<void> {
    const session = this.require(id);
    if (session.kind !== "agent" || !session.agent) {
      throw new Error("Only a robot session has a browser to restart");
    }
    if (session.restartingBrowser) return;
    session.restartingBrowser = true;

    try {
      const site = await this.deps.store.site(session.siteProfileId);
      if (!site) {
        throw new SessionError("The site is no longer available", "unknown_site");
      }

      const account = await this.deps.store.siteAccount(session.userId, session.siteProfileId);
      if (!account) {
        throw new SessionError("You have no account on this site", "no_site_account");
      }

      const shouldResume =
        (session.status === "working" || session.status === "awaiting_approval") &&
        Boolean(session.lastUserMessage);
      const wasPreviewing = session.previewEnabled;
      await session.screencast?.stop().catch(() => {});
      session.screencast = undefined;
      session.previewEnabled = false;
      // The cached frame shows a browser that is about to stop existing.
      session.lastFrame = undefined;

      const usesSavedLogin = site.loginStrategy === "persistent_profile";
      const old = session.browser;
      const oldAgent = session.agent;

      // Stop the worker whose MCP process is pinned to the dead endpoint before
      // launching its replacement.
      await oldAgent.stop().catch(() => {});
      await old.close().catch(() => {});

      // A saved-login site gets a fresh copy of the profile, so the restarted
      // browser is logged in the same way the original one was.
      if (usesSavedLogin && session.scratchProfileDir) {
        await this.discardScratch(session.scratchProfileDir);
        await this.deps.profiles.checkout(
          session.siteProfileId,
          session.userId,
          session.scratchProfileDir,
        );
      }

      const browser = await this.launchBrowserWithRetry({
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

      // A recovered session keeps the model it started with, but the provider
      // is re-resolved: an administrator may have switched it precisely
      // because the old one had stopped answering.
      const provider = await this.deps.resolveProvider();
      if (!provider) throw new Error("No model provider is configured");
      const recoveredModel = session.model ?? (await this.deps.store.settings()).defaultModel;

      let agent: AgentRunner;
      try {
        agent = await this.deps.startAgent({
          cdpEndpoint: browser.cdpEndpoint,
          site,
          model: recoveredModel,
          ...agentProviderOptions(provider, recoveredModel),
          nodeBin: this.config.nodeBin,
          sessionId: id,
          saveFile: (filename, bytes) =>
            this.storeBytes(id, join(this.config.downloadsRoot, id), filename, bytes),
          onEvent: (event) => this.handleEvent(id, event),
        });
      } catch (error) {
        await browser.close().catch(() => {});
        throw error;
      }

      session.browser = browser;
      session.agent = agent;
      this.attachDownloads(
        id,
        browser,
        join(this.config.downloadsRoot, id),
        (filename) => agent.downloadDetected(filename),
        (filename) => agent.downloadCompleted(filename),
      );
      this.watchBrowser(id, browser);

      this.handleEvent(id, {
        type: "tool_activity",
        tool: "browser_restart",
        summary: automatic
          ? "Browser exited and recovered automatically"
          : "Browser restarted — back on the home page",
      });

      if (wasPreviewing) await this.setPreview(id, true);

      if (shouldResume && session.lastUserMessage) {
        this.setStatus(session, "working");
        agent.send(
          `Chromium exited and has been restarted at the application's home page. Resume this user request from the beginning using a fresh snapshot: ${session.lastUserMessage}`,
        );
      } else {
        this.setStatus(session, "idle");
      }
    } finally {
      const current = this.sessions.get(id);
      if (current) current.restartingBrowser = false;
    }
  }

  async stop(id: string, reason = "stopped by user"): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await Promise.all([...session.pendingWrites]);
    await this.deps.store
      .checkpointSession(id, {
        lastUrl: session.browser.page.url(),
        ...(session.lastUserMessage ? { lastUserMessage: session.lastUserMessage } : {}),
      })
      .catch(() => {});

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
    if (event.type === "approval_request" || event.type === "choice_request") {
      this.setStatus(session, "awaiting_approval");
    }
    if (event.type === "file_ready") this.setStatus(session, "idle");
    if (event.type === "error") this.setStatus(session, "failed");
    if (event.type === "agent_turn_complete") {
      const belongsToActiveVoiceTask =
        event.voiceTaskId && event.voiceTaskId === session.activeVoiceTaskId;
      if (belongsToActiveVoiceTask) session.activeVoiceTaskId = undefined;
      if (!event.voiceTaskId || belongsToActiveVoiceTask) {
        this.setStatus(session, event.outcome === "failed" ? "failed" : "idle");
      }
      if (event.voiceTaskId) {
        console.info(
          JSON.stringify({
            component: "live_voice",
            event: "browser_task.complete",
            sessionId: id,
            requestId: event.voiceTaskId,
            outcome: event.outcome,
          }),
        );
      }
    }

    this.emit(session, event);

    // Deltas are useful only while connected. Persisting every token would
    // bloat the transcript and duplicate the complete agent_text event.
    if (event.type === "agent_text_delta") return;

    // Persist for replay. Status changes are already written by setStatus, and
    // preview frames never come through here, so this stays cheap.
    this.persist(session, () =>
      this.deps.store.appendEvent(id, event, { lastUrl: session.browser.page.url() }),
    );
  }

  /** Track concurrent durable writes and establish a clean handoff boundary at stop. */
  private persist(session: Session, write: () => Promise<void>): void {
    const pending = write().catch(() => {});
    session.pendingWrites.add(pending);
    void pending.finally(() => session.pendingWrites.delete(pending));
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
