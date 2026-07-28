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

  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: opts.quality ?? 60,
    maxWidth: opts.maxWidth ?? 900,
    maxHeight: opts.maxHeight ?? 1600,
    everyNthFrame: opts.everyNthFrame ?? 2,
  });

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
