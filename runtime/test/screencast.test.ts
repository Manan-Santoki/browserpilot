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

/** base64 of a JPEG's 0xFF 0xD8 0xFF magic bytes always starts with this. */
const JPEG = "/9j/";

let server: ReturnType<typeof Bun.serve>;
let browser: RobotBrowser;
let downloadsDir: string;
let base: string;

beforeAll(async () => {
  // Deliberately static: Chromium only emits screencast frames on repaint, so
  // this is the case that proves frames arrive without one.
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(
        `<html><body style="background:#c00"><h1>${new URL(req.url).pathname}</h1></body></html>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  base = `http://127.0.0.1:${server.port}`;
  downloadsDir = await mkdtemp(join(tmpdir(), "bp-dl-"));
  browser = await launchRobotBrowser({
    targetUrl: base,
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

/** Pixel dimensions from a JPEG's start-of-frame marker. */
function jpegDimensions(base64: string): { w: number; h: number } | undefined {
  const buf = Buffer.from(base64, "base64");
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

describe("startScreencast", () => {
  test("delivers JPEG frames while running and stops delivering after stop()", async () => {
    const frames: string[] = [];
    const handle = await startScreencast(browser.context, (frame) => frames.push(frame));

    await Bun.sleep(1500);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.startsWith(JPEG)).toBe(true);

    await handle.stop();
    const countAtStop = frames.length;
    await Bun.sleep(600);
    expect(frames.length).toBe(countAtStop);
  }, 30_000);

  test("a page that never repaints is shown once, not streamed repeatedly", async () => {
    // This is the ordinary case — a business page sitting there between the
    // agent's actions. Chromium emits nothing at all for it, so the frame has
    // to be asked for. Asking again and again would send the same picture
    // every second for as long as anyone watched; a viewer that arrives later
    // is caught up from the last frame instead.
    const frames: string[] = [];
    const handle = await startScreencast(browser.context, (frame) => frames.push(frame), {
      settleMs: 150,
      heartbeatMs: 200,
    });

    await Bun.sleep(600);
    const afterSettling = frames.length;
    await Bun.sleep(1000);
    await handle.stop();

    // Something arrived without the page doing anything.
    expect(afterSettling).toBeGreaterThan(0);
    // And it did not keep arriving: a still page costs nothing to watch.
    expect(frames.length).toBe(afterSettling);
    expect(frames.every((f) => f.startsWith(JPEG))).toBe(true);
  }, 30_000);

  test("the still frame is sharper than the moving ones", async () => {
    // Page.startScreencast renders at CSS pixel size whatever the device scale
    // factor is, which is why the live stream looks soft. The frame taken once
    // the page settles is captured at the viewer's real pixel density instead.
    const sizes: Array<{ w: number; h: number }> = [];
    const handle = await startScreencast(
      browser.context,
      (frame) => {
        const size = jpegDimensions(frame);
        if (size) sizes.push(size);
      },
      { settleMs: 150 },
    );
    handle.resize(1200, 2);

    await Bun.sleep(900);
    await handle.stop();

    const widest = Math.max(...sizes.map((s) => s.w));
    // The viewport is 800 CSS px wide in this fixture, so anything above it
    // could only have come from the high-resolution capture.
    expect(widest).toBeGreaterThan(800);
  }, 30_000);

  test("the fps ceiling holds even when the page repaints constantly", async () => {
    const animated = await browser.context.newPage();
    await animated.goto(`${base}/animated`);
    await animated.evaluate(() => {
      const box = document.createElement("div");
      box.style.cssText =
        "width:120px;height:120px;background:#0f0;animation:spin .4s linear infinite";
      const style = document.createElement("style");
      style.textContent = "@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}";
      document.head.append(style);
      document.body.append(box);
    });

    const frames: string[] = [];
    const handle = await startScreencast(browser.context, (frame) => frames.push(frame), {
      fps: 5,
      heartbeatMs: 10_000,
    });

    await Bun.sleep(2000);
    await handle.stop();
    await animated.close();

    // Unthrottled this page delivers well over 30fps. Allow generous slack for
    // the initial frame and a slow CI box, but it must be nowhere near that.
    expect(frames.length).toBeLessThan(20);
    expect(frames.length).toBeGreaterThan(2);
  }, 30_000);

  test("the view follows the agent into a newly opened tab", async () => {
    // The failure this covers is the worst kind: pinned to the first page, the
    // preview keeps showing a perfectly good still of an abandoned tab, so the
    // robot looks frozen rather than broken.
    const handle = await startScreencast(browser.context, () => {}, { heartbeatMs: 10_000 });
    await Bun.sleep(300);

    const second = await browser.context.newPage();
    await second.goto(`${base}/second-tab`);

    const frames: string[] = [];
    const watcher = await startScreencast(browser.context, (frame) => frames.push(frame), {
      heartbeatMs: 250,
    });
    await Bun.sleep(800);

    // Paint only the new tab. If the stream were pinned to the first page, no
    // frame would change and the second tab's red heading would never appear.
    await second.evaluate(() => {
      document.body.style.background = "#00f";
    });
    await Bun.sleep(600);

    await watcher.stop();
    await handle.stop();
    await second.close();

    expect(frames.length).toBeGreaterThan(1);
    // The repaint has to have reached us: the last frame differs from the first.
    expect(frames.at(-1)).not.toBe(frames[0]);
  }, 30_000);

  test("closing the watched tab hands the view to what is left", async () => {
    const extra = await browser.context.newPage();
    await extra.goto(`${base}/closing`);

    const frames: string[] = [];
    const handle = await startScreencast(browser.context, (frame) => frames.push(frame), {
      heartbeatMs: 200,
    });
    await Bun.sleep(500);

    await extra.close();
    const countAtClose = frames.length;
    await Bun.sleep(800);

    // The stream must survive losing the tab it was watching.
    expect(frames.length).toBeGreaterThan(countAtClose);
    await handle.stop();
  }, 30_000);
});
