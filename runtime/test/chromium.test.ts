import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify } from "jose";
import { launchRobotBrowser, type RobotBrowser } from "../src/browser/chromium";

const USER = {
  userId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
  email: "owner@jwm.test",
  role: "admin",
  name: "Manan Santoki",
};
const SECRET = "shared-with-jwm";

let server: ReturnType<typeof Bun.serve>;
let browser: RobotBrowser;
let downloadsDir: string;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const cookie = req.headers.get("cookie") ?? "";
      const token = /jwm-session=([^;]+)/.exec(cookie)?.[1] ?? "";
      return new Response(
        `<html><body><h1 id="who">${token ? "authed" : "anon"}</h1><pre id="token">${token}</pre></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  downloadsDir = await mkdtemp(join(tmpdir(), "bp-dl-"));
  browser = await launchRobotBrowser({
    targetUrl: `http://127.0.0.1:${server.port}`,
    user: USER,
    sessionSecret: SECRET,
    downloadsDir,
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  await rm(downloadsDir, { recursive: true, force: true });
});

describe("launchRobotBrowser", () => {
  test("lands on the target URL already carrying the robot cookie", async () => {
    expect(await browser.page.textContent("#who")).toBe("authed");
  });

  test("the cookie it sent is a valid robot token for our user", async () => {
    const token = (await browser.page.textContent("#token"))!;
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.userId).toBe(USER.userId);
    expect(payload.robot).toBe(true);
  });

  test("exposes a reachable CDP endpoint for Playwright MCP to attach to", async () => {
    expect(browser.cdpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const version = await fetch(`${browser.cdpEndpoint}/json/version`).then((r) => r.json());
    expect(version.webSocketDebuggerUrl).toContain("ws://");
  });

  test("reports the downloads directory it was given", () => {
    expect(browser.downloadsDir).toBe(downloadsDir);
  });
});
