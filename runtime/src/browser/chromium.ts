import { chromium, type BrowserContext, type Download, type Page } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRobotCookie, type TargetUser } from "../auth/mint";

/** A cookie captured from a sign-in and kept until the next session. */
export type SavedCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Seconds since the epoch; -1 marks a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
};

export type LaunchOptions = {
  targetUrl: string;
  /** Present for cookie_mint sites; a saved profile carries its own identity. */
  user?: TargetUser;
  sessionSecret?: string;
  /** Cookie name the target reads — a property of the site, not of us. */
  cookieName?: string;
  downloadsDir: string;
  cookieTtlSeconds?: number;
  /**
   * Launch from this directory instead of a throwaway one. Used both by a login
   * session, which writes the person's sign-in into it, and by an agent session
   * running from a disposable copy of that profile.
   */
  profileDir?: string;
  /** Skip the opening navigation — a login session drives itself there. */
  skipNavigation?: boolean;
  /**
   * Cookies captured from an earlier sign-in, applied before the first
   * navigation. The profile carries local storage and the rest; these are here
   * because Chromium never writes session cookies to disk.
   */
  cookies?: SavedCookie[];
};

export type DownloadHandler = (download: {
  suggestedFilename: string;
  saveAs: (path: string) => Promise<void>;
}) => void;

export type RobotBrowser = {
  cdpEndpoint: string;
  downloadsDir: string;
  /** Where this browser's profile lives, so a session can write it back. */
  profileDir: string;
  page: Page;
  context: BrowserContext;
  onDownload(handler: DownloadHandler): void;
  close(): Promise<void>;
};

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port == null) throw new Error("Could not allocate a debugging port");
  return port;
}

async function waitForCdp(endpoint: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`CDP endpoint ${endpoint} did not come up`);
    await Bun.sleep(150);
  }
}

export async function launchRobotBrowser(opts: LaunchOptions): Promise<RobotBrowser> {
  const port = await freePort();
  const profileDir = opts.profileDir ?? (await mkdtemp(join(tmpdir(), "bp-profile-")));

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    acceptDownloads: true,
    downloadsPath: opts.downloadsDir,
    viewport: { width: 1600, height: 1000 },
    // Renders text and rules at twice the density, which is what makes the
    // settled frame sharp. Screencast frames stay at CSS size regardless, so
    // this costs nothing while the page is moving.
    deviceScaleFactor: 2,
    args: [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"],
  });

  const cdpEndpoint = `http://127.0.0.1:${port}`;
  await waitForCdp(cdpEndpoint);

  // A site we hold the signing secret for gets a freshly minted session. A site
  // the person signed in to themselves already carries one in its profile.
  if (opts.user && opts.sessionSecret) {
    const token = await mintRobotCookie(opts.user, opts.sessionSecret, opts.cookieTtlSeconds);
    await context.addCookies([
      {
        name: opts.cookieName ?? "session",
        value: token,
        url: opts.targetUrl,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }

  if (opts.cookies?.length) {
    // Before navigating: a request that goes out without them lands on the
    // target's sign-in page and is what we are trying to avoid.
    await context.addCookies(opts.cookies).catch(() => {});
  }

  const page = context.pages()[0] ?? (await context.newPage());
  if (!opts.skipNavigation) {
    await page.goto(opts.targetUrl, { waitUntil: "domcontentloaded" });
  }

  return {
    cdpEndpoint,
    downloadsDir: opts.downloadsDir,
    profileDir,
    page,
    context,
    onDownload(handler: DownloadHandler) {
      context.on("download", (download: Download) => {
        handler({
          suggestedFilename: download.suggestedFilename(),
          saveAs: (path: string) => download.saveAs(path),
        });
      });
    },
    async close() {
      await context.close();
    },
  };
}
