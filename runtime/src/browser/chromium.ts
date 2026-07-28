import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRobotCookie, ROBOT_COOKIE_NAME, type JwmUser } from "../auth/mint";

export type LaunchOptions = {
  targetUrl: string;
  user: JwmUser;
  sessionSecret: string;
  downloadsDir: string;
  cookieTtlSeconds?: number;
};

export type RobotBrowser = {
  cdpEndpoint: string;
  downloadsDir: string;
  page: Page;
  context: BrowserContext;
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
  const profileDir = await mkdtemp(join(tmpdir(), "bp-profile-"));

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    acceptDownloads: true,
    downloadsPath: opts.downloadsDir,
    viewport: { width: 1280, height: 800 },
    args: [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"],
  });

  const cdpEndpoint = `http://127.0.0.1:${port}`;
  await waitForCdp(cdpEndpoint);

  const token = await mintRobotCookie(opts.user, opts.sessionSecret, opts.cookieTtlSeconds);
  await context.addCookies([
    {
      name: ROBOT_COOKIE_NAME,
      value: token,
      url: opts.targetUrl,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(opts.targetUrl, { waitUntil: "domcontentloaded" });

  return {
    cdpEndpoint,
    downloadsDir: opts.downloadsDir,
    page,
    context,
    async close() {
      await context.close();
    },
  };
}
