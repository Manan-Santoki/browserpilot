import type { BrowserContext, CDPSession, Page } from "playwright";

export type ScreencastHandle = {
  stop(): Promise<void>;
  /** Ask for frames sized for the viewer's panel. Safe to call repeatedly. */
  resize(cssWidth: number, pixelRatio: number): void;
};

export type ScreencastOptions = {
  /** Quality of the frames sent while the page is moving. */
  quality?: number;
  /** Quality of the sharp frame sent once it settles. */
  settledQuality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Ceiling on frames forwarded per second, whatever Chromium produces. */
  fps?: number;
  /** Still for this long, and the sharp frame is taken. */
  settleMs?: number;
  /** Capture a frame anyway once the watched page has been still this long. */
  heartbeatMs?: number;
  /** How quiet the watched tab must go before another may take the view. */
  switchAfterMs?: number;
  /** Upper bound on the sharp frame, as a multiple of CSS pixels. */
  maxScale?: number;
  /** How long a capture's own repaint is ignored for. */
  captureEchoMs?: number;
};

const DEFAULTS = {
  quality: 70,
  settledQuality: 90,
  maxWidth: 1920,
  maxHeight: 1920,
  fps: 12,
  settleMs: 350,
  heartbeatMs: 1500,
  switchAfterMs: 900,
  maxScale: 2,
  captureEchoMs: 250,
};

type Metrics = {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
};

/**
 * Stream what the browser is showing, as JPEG frames.
 *
 * This watches the whole context rather than a single page, because the agent
 * opens and switches tabs as it works. A screencast pinned to one page shows a
 * still photograph of an abandoned tab from the moment the agent moves on —
 * which is indistinguishable, to whoever is watching, from the robot freezing.
 *
 * Chromium gives two ways to see a page, and neither is sufficient alone:
 *
 *   - Page.startScreencast is cheap and continuous, but always renders at CSS
 *     pixel size. maxWidth cannot raise it; a 1600px viewport yields a 1600px
 *     frame however high the device scale factor is. On any modern display that
 *     is upscaled to fit the panel, which is exactly the softness people see.
 *   - Page.captureScreenshot with clip.scale renders at whatever multiple you
 *     ask for, and is sharp — but it is a round trip per frame, far too slow to
 *     drive a live stream.
 *
 * So each is used for what it is good at. While the page is moving, the cheap
 * stream carries the motion, because nobody reads a page mid-scroll. The moment
 * it settles — which is when someone actually looks at it — one sharp frame is
 * taken at full device resolution and replaces it. Reading is crisp, motion is
 * smooth, and neither pays for the other.
 */
export async function startScreencast(
  context: BrowserContext,
  onFrame: (jpegBase64: string) => void,
  opts: ScreencastOptions = {},
): Promise<ScreencastHandle> {
  const cfg = { ...DEFAULTS, ...opts };
  const minGapMs = Math.max(1, Math.round(1000 / cfg.fps));

  const attached = new Map<Page, CDPSession>();
  let stopped = false;

  /** The tab whose frames reach the viewer, and when it last painted. */
  let watched: Page | undefined;
  let watchedPaintedAt = 0;
  /** Consecutive frames from a tab that is not the watched one. */
  let challenger: { page: Page; frames: number } | undefined;

  let sentAt = 0;
  let pending: string | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  /** Set once the sharp frame for the current stillness has been sent. */
  let settled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Taking the sharp frame forces Chromium to commit a new one, which the
   * screencast then reports as movement. Left alone that soft frame paints
   * straight over the sharp one and starts another settle — a visible flicker
   * on a page that is not changing at all. Frames are ignored briefly after a
   * capture for that reason.
   */
  let ignoreFramesUntil = 0;

  /** What the viewer's panel can actually show, in device pixels. */
  let wantedPixels = cfg.maxWidth;

  const now = () => Date.now();

  function send(frame: string): void {
    sentAt = now();
    pending = undefined;
    if (!stopped) onFrame(frame);
  }

  /**
   * Take the sharp frame, once the page has stopped changing.
   *
   * Scale is chosen from what the viewer can display: sending three times the
   * pixels of the panel it lands in costs bandwidth and buys nothing.
   */
  async function sendSettled(page: Page): Promise<void> {
    if (stopped || settled) return;
    const client = attached.get(page);
    if (!client) return;

    try {
      const { cssVisualViewport: view } = (await client.send("Page.getLayoutMetrics")) as Metrics;
      if (view.clientWidth === 0 || view.clientHeight === 0) return;

      const scale = Math.min(cfg.maxScale, Math.max(1, wantedPixels / view.clientWidth));
      const shot = (await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: cfg.settledQuality,
        captureBeyondViewport: false,
        clip: {
          x: view.pageX,
          y: view.pageY,
          width: view.clientWidth,
          height: view.clientHeight,
          scale,
        },
      })) as { data: string };

      // A repaint may have landed while this was in flight, in which case the
      // page is moving again and this frame is already history.
      if (!stopped && !settled && watched === page) {
        settled = true;
        send(shot.data);
        ignoreFramesUntil = now() + cfg.captureEchoMs;
      }
    } catch {
      // Navigated or closed under us; the next stillness tries again.
    }
  }

  function scheduleSettle(page: Page): void {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      void sendSettled(page);
    }, cfg.settleMs);
  }

  /**
   * Take a frame from one of the tabs and decide whether the viewer sees it.
   *
   * Whichever tab is painting owns the view — that is where the work is — but a
   * single frame is not enough to claim it. Background tabs repaint for reasons
   * nobody is watching for: an advert, a spinner, a favicon. Requiring a run of
   * frames, and a real pause from the incumbent, keeps the view where the work
   * is instead of letting it flit between tabs.
   */
  function offer(page: Page, frame: string): void {
    if (stopped) return;
    if (now() < ignoreFramesUntil) return;

    if (watched && watched !== page) {
      if (now() - watchedPaintedAt <= cfg.switchAfterMs) return;

      // The incumbent has gone quiet; make the challenger prove it is busy.
      challenger =
        challenger?.page === page ? { page, frames: challenger.frames + 1 } : { page, frames: 1 };
      if (challenger.frames < 3) return;
    }

    challenger = undefined;
    watched = page;
    watchedPaintedAt = now();

    // The page is moving, so any sharp frame is stale and a new stillness has
    // not happened yet.
    settled = false;
    scheduleSettle(page);

    const wait = minGapMs - (now() - sentAt);
    if (wait <= 0) {
      send(frame);
      return;
    }

    // Over the ceiling: hold the newest frame and let the timer flush it, so a
    // burst of movement still settles on the state the page actually ended in.
    pending = frame;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (pending !== undefined) send(pending);
      }, wait);
    }
  }

  async function attach(page: Page): Promise<void> {
    if (stopped || attached.has(page)) return;

    let client: CDPSession;
    try {
      client = await page.context().newCDPSession(page);
    } catch {
      return; // closed between the event firing and us getting here
    }
    if (stopped) {
      await client.detach().catch(() => {});
      return;
    }
    attached.set(page, client);

    client.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      offer(page, event.data);
      // The frame must be acked or Chromium stops sending more.
      client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    });

    page.once("close", () => void detach(page));

    try {
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: cfg.quality,
        maxWidth: cfg.maxWidth,
        maxHeight: cfg.maxHeight,
        // Chromium's own frame skipping is blunt: it drops frames whether or
        // not the bandwidth is wanted, and halves the rate of a slow page as
        // readily as a fast one. Take everything and let the fps ceiling choose.
        everyNthFrame: 1,
      });
    } catch {
      attached.delete(page);
      await client.detach().catch(() => {});
      return;
    }

    // A new tab is where the agent is about to work, so it takes the view
    // outright: the challenger rule below exists for tabs that were already
    // open and merely twitched, not for one that just appeared.
    watched = page;
    watchedPaintedAt = now();
    challenger = undefined;
    settled = false;
    scheduleSettle(page);
  }

  async function detach(page: Page): Promise<void> {
    const client = attached.get(page);
    if (!client) return;
    attached.delete(page);

    if (watched === page) {
      // Let whichever tab survives claim the view immediately rather than
      // waiting out a switch delay against a page that no longer exists.
      watched = undefined;
      watchedPaintedAt = 0;
      challenger = undefined;
      settled = false;

      const survivor = attached.keys().next().value;
      if (survivor) {
        watched = survivor;
        // It may be perfectly still, and a still page paints nothing at all —
        // so ask it for a frame rather than wait for one.
        scheduleSettle(survivor);
      }
    }

    try {
      await client.send("Page.stopScreencast");
    } catch {
      // page already gone
    }
    await client.detach().catch(() => {});
  }

  const onPage = (page: Page) => void attach(page);
  context.on("page", onPage);

  // Sequentially, so the context's first page is the one being watched when
  // there is nothing to distinguish them.
  for (const page of context.pages()) await attach(page);

  // For a page that never paints at all — one that loaded before anyone was
  // watching, and has nothing to say since.
  const heartbeat = setInterval(
    () => {
      if (stopped || settled || now() - sentAt < cfg.heartbeatMs) return;
      const page = watched ?? attached.keys().next().value;
      if (page) void sendSettled(page);
    },
    Math.max(200, Math.round(cfg.heartbeatMs / 2)),
  );

  return {
    resize(cssWidth: number, pixelRatio: number) {
      const wanted = Math.round(cssWidth * pixelRatio);
      if (!Number.isFinite(wanted) || wanted <= 0) return;

      const clamped = Math.min(Math.max(wanted, 640), cfg.maxWidth * cfg.maxScale);
      if (clamped === wantedPixels) return;
      wantedPixels = clamped;

      // The next stillness re-takes the sharp frame at the new size; there is
      // no need to disturb the running stream to do it.
      settled = false;
      if (watched) scheduleSettle(watched);
    },

    async stop() {
      stopped = true;
      context.off("page", onPage);
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      if (settleTimer) clearTimeout(settleTimer);
      flushTimer = undefined;
      settleTimer = undefined;
      await Promise.all([...attached.keys()].map((page) => detach(page)));
    },
  };
}
