import type { BrowserContext, CDPSession, Page } from "playwright";

export type ScreencastHandle = {
  stop(): Promise<void>;
};

export type ScreencastOptions = {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Ceiling on frames forwarded per second, whatever Chromium produces. */
  fps?: number;
  /** Capture a frame anyway once the watched page has been still this long. */
  heartbeatMs?: number;
  /** How quiet the watched tab must go before another may take the view. */
  switchAfterMs?: number;
};

const DEFAULTS = {
  quality: 60,
  maxWidth: 900,
  maxHeight: 1600,
  fps: 12,
  heartbeatMs: 1000,
  switchAfterMs: 400,
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
 * Two things stand between Chromium and a stream that looks live:
 *
 *   - Frames only exist when the page repaints. A page merely sitting there
 *     produces none at all, so the heartbeat captures one on demand.
 *   - A repainting page produces far more than anyone needs to see. The fps
 *     ceiling coalesces them, always keeping the newest, so motion stays smooth
 *     without paying for thirty frames a second of it.
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

  let sentAt = 0;
  let pending: string | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const now = () => Date.now();

  function send(frame: string): void {
    sentAt = now();
    pending = undefined;
    if (!stopped) onFrame(frame);
  }

  /**
   * Take a frame from one of the tabs and decide whether the viewer sees it.
   *
   * Whichever tab is painting owns the view — that is where the work is — but
   * only once the tab we are watching has gone quiet. Without that pause, two
   * live tabs would trade the panel back and forth on every frame and the
   * result would be unwatchable.
   */
  function offer(page: Page, frame: string): void {
    if (stopped) return;

    if (watched && watched !== page && now() - watchedPaintedAt <= cfg.switchAfterMs) return;
    watched = page;
    watchedPaintedAt = now();

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

  /**
   * A frame captured on demand, for a page that simply is not repainting.
   *
   * Chromium scales screencast frames to maxWidth/maxHeight but leaves a plain
   * captureScreenshot at full size, so this clips to the visible viewport and
   * applies the same factor. Otherwise every heartbeat would arrive at a
   * different resolution from the frames around it.
   */
  async function capture(page: Page): Promise<string | undefined> {
    const client = attached.get(page);
    if (!client) return undefined;
    try {
      const { cssVisualViewport: view } = (await client.send("Page.getLayoutMetrics")) as Metrics;
      const scale = Math.min(
        1,
        cfg.maxWidth / view.clientWidth,
        cfg.maxHeight / view.clientHeight,
      );
      const shot = (await client.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: cfg.quality,
        captureBeyondViewport: false,
        clip: {
          x: view.pageX,
          y: view.pageY,
          width: view.clientWidth,
          height: view.clientHeight,
          scale,
        },
      })) as { data: string };
      return shot.data;
    } catch {
      // The page may have navigated or closed under us; the next tick retries.
      return undefined;
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

    // A new tab is where the agent is about to work, and a tab that opens onto
    // something static would otherwise announce itself with nothing at all.
    const first = await capture(page);
    if (first) offer(page, first);
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

  const heartbeat = setInterval(
    () => {
      if (stopped || now() - sentAt < cfg.heartbeatMs) return;
      const page = watched ?? attached.keys().next().value;
      if (!page) return;
      void capture(page).then((frame) => {
        // A real repaint may have arrived while the capture was in flight.
        if (frame && !stopped && now() - sentAt >= cfg.heartbeatMs) send(frame);
      });
    },
    Math.max(100, Math.round(cfg.heartbeatMs / 2)),
  );

  return {
    async stop() {
      stopped = true;
      context.off("page", onPage);
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      await Promise.all([...attached.keys()].map((page) => detach(page)));
    },
  };
}
