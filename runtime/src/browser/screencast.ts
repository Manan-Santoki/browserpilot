import type { Page } from "playwright";

export type ScreencastHandle = {
  stop(): Promise<void>;
};

export type ScreencastOptions = {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
};

export async function startScreencast(
  page: Page,
  onFrame: (jpegBase64: string) => void,
  opts: ScreencastOptions = {},
): Promise<ScreencastHandle> {
  const client = await page.context().newCDPSession(page);
  let stopped = false;

  client.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
    if (!stopped) onFrame(event.data);
    // The frame must be acked or Chromium stops sending more.
    client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });

  const quality = opts.quality ?? 60;

  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth: opts.maxWidth ?? 900,
    maxHeight: opts.maxHeight ?? 1600,
    everyNthFrame: opts.everyNthFrame ?? 2,
  });

  // Chromium only emits screencast frames when the page repaints, so a page
  // that is merely sitting there would leave the viewer staring at nothing
  // until the agent's next action. Push the current state immediately.
  try {
    const shot = (await client.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
    })) as { data: string };
    if (!stopped) onFrame(shot.data);
  } catch {
    // A frame from a repaint will arrive instead; not worth failing the start.
  }

  return {
    async stop() {
      stopped = true;
      try {
        await client.send("Page.stopScreencast");
      } catch {
        // page may already be gone
      }
      await client.detach().catch(() => {});
    },
  };
}
