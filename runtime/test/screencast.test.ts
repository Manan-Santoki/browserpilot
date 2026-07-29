import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchRobotBrowser, type RobotBrowser } from "../src/browser/chromium";
import { startScreencast } from "../src/browser/screencast";

const USER = {
  userId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
  email: "owner@jwm.test",
  role: "admin",
  name: "Manan Santoki",
};

let server: ReturnType<typeof Bun.serve>;
let browser: RobotBrowser;
let downloadsDir: string;

beforeAll(async () => {
  // Deliberately static: Chromium only emits screencast frames on repaint, so
  // this is the case that proves we push an initial frame ourselves.
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(`<html><body style="background:#c00"><h1>static page</h1></body></html>`, {
        headers: { "content-type": "text/html" },
      }),
  });
  downloadsDir = await mkdtemp(join(tmpdir(), "bp-dl-"));
  browser = await launchRobotBrowser({
    targetUrl: `http://127.0.0.1:${server.port}`,
    user: USER,
    sessionSecret: "site-secret",
    cookieName: "target-session",
    downloadsDir,
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  await rm(downloadsDir, { recursive: true, force: true });
});

describe("startScreencast", () => {
  test("delivers JPEG frames while running and stops delivering after stop()", async () => {
    const frames: string[] = [];
    const handle = await startScreencast(browser.page, (frame) => frames.push(frame));

    await Bun.sleep(1500);
    // A static page repaints never — without an initial frame this is 0.
    expect(frames.length).toBeGreaterThan(0);

    // JPEG magic bytes: base64 of 0xFF 0xD8 0xFF always starts with "/9j/"
    expect(frames[0]!.startsWith("/9j/")).toBe(true);

    await handle.stop();
    const countAtStop = frames.length;
    await Bun.sleep(500);
    expect(frames.length).toBe(countAtStop);
  }, 30_000);
});
