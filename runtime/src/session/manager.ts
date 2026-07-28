import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentRunner } from "../agent/runner";
import type { RobotBrowser } from "../browser/chromium";
import type { JwmUser } from "../auth/mint";
import type { RobotEvent, SessionStatus } from "./events";

export type LaunchArgs = {
  targetUrl: string;
  user: JwmUser;
  sessionSecret: string;
  downloadsDir: string;
};

export type AgentArgs = {
  cdpEndpoint: string;
  jwmUrl: string;
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
  now: () => number;
};

export type ManagerConfig = {
  jwmUrl: string;
  sessionSecret: string;
  downloadsRoot: string;
  model: string;
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  hardCapMs: number;
  env: Record<string, string>;
  nodeBin?: string;
};

export type Session = {
  id: string;
  user: JwmUser;
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

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private config: ManagerConfig,
    private deps: ManagerDeps,
  ) {}

  async create(user: JwmUser): Promise<string> {
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error("Concurrent session limit reached");
    }

    const id = randomUUID();
    const downloadsDir = join(this.config.downloadsRoot, id);
    await mkdir(downloadsDir, { recursive: true }).catch(() => {});

    const browser = await this.deps.launchBrowser({
      targetUrl: this.config.jwmUrl,
      user,
      sessionSecret: this.config.sessionSecret,
      downloadsDir,
    });

    browser.onDownload((download) => {
      // basename() prevents a hostile suggested filename from escaping the dir.
      const filename = basename(download.suggestedFilename) || "download";
      const target = join(downloadsDir, filename);
      void download
        .saveAs(target)
        .then(() => {
          this.handleEvent(id, {
            type: "file_ready",
            fileId: filename,
            filename,
            url: `/api/sessions/${id}/files/${encodeURIComponent(filename)}`,
          });
        })
        .catch((error: Error) => {
          this.handleEvent(id, { type: "error", message: `Download failed: ${error.message}` });
        });
    });

    let agent: AgentRunner;
    try {
      agent = await this.deps.startAgent({
        cdpEndpoint: browser.cdpEndpoint,
        jwmUrl: this.config.jwmUrl,
        model: this.config.model,
        env: this.config.env,
        nodeBin: this.config.nodeBin,
        onEvent: (event) => this.handleEvent(id, event),
      });
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }

    const now = this.deps.now();
    this.sessions.set(id, {
      id,
      user,
      status: "idle",
      startedAt: now,
      lastActivityAt: now,
      previewEnabled: false,
      browser,
      agent,
      listeners: new Set(),
      frameListeners: new Set(),
    });

    return id;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  subscribe(id: string, listener: (event: RobotEvent) => void): () => void {
    const session = this.require(id);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
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

  subscribeFrames(id: string, listener: (frame: string) => void): () => void {
    const session = this.require(id);
    session.frameListeners.add(listener);
    return () => session.frameListeners.delete(listener);
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

  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.screencast?.stop().catch(() => {});
    session.screencast = undefined;
    this.emit(session, { type: "session_status", status: "stopped" });
    await session.agent.stop().catch(() => {});
    await session.browser.close().catch(() => {});
  }

  async sweep(): Promise<void> {
    const now = this.deps.now();
    const expired = this.list().filter(
      (s) =>
        now - s.lastActivityAt > this.config.idleTimeoutMs ||
        now - s.startedAt > this.config.hardCapMs,
    );
    await Promise.all(expired.map((s) => this.stop(s.id)));
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
  }

  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    this.emit(session, { type: "session_status", status });
  }

  private emit(session: Session, event: RobotEvent): void {
    for (const listener of session.listeners) listener(event);
  }
}
