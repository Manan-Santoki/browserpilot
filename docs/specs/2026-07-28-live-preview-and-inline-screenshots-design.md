# Live preview, and screenshots you can actually see

**Date:** 2026-07-28
**Status:** Implemented

Two complaints, one session: the browser panel "is not really live, it's just
images", and asking the agent for a screenshot produced prose but no picture.
They turned out to be four separate defects.

## What was wrong

### The preview

Measured against a real headless Chromium, with the settings as they were:

| Page state | Frames delivered |
|---|---|
| Animated page | 32 fps |
| **Static page** | **0.3 fps** |
| Static page, while scrolling | 5 fps |
| **After the agent opens a second tab** | **0 fps, permanently** |

1. **The screencast was pinned to `browser.page`** — the page captured at
   launch. Playwright MCP keeps its own current tab and calls `newTab()` freely.
   Once the agent worked in a second tab, the panel showed a frozen picture of
   the first one for the rest of the session. This is the worst failure of the
   four, because a still photograph of a real page does not look like a bug; it
   looks like the robot has stopped.
2. **Chromium only emits a frame when the page repaints.** A business page
   sitting between agent actions emits none, so the panel held whatever it last
   received. That is the literal "it's just images".
3. **`everyNthFrame: 2`** halved what remained, which is why active scrolling
   arrived at 5 fps rather than around 11.
4. No frame was cached, so a reload showed an empty panel until the next
   repaint; and the client minted an object URL per frame and swapped an
   `<img>`, which flickers and leaks if a revoke is ever missed.

An earlier hypothesis — that Chromium stops compositing background tabs — was
tested and is false. Headless Chromium has no window, every tab reports
`document.visibilityState === "visible"`, and `Page.screencastVisibilityChanged`
only ever fires `true`. Neither is usable for finding the active tab. What
*is* true is that a tab only paints when its own content changes, which is why
the pinned stream went quiet rather than the tab going dark.

### The screenshots

From `@playwright/mcp`'s own source:

```js
await response.addFileResult(resolvedFile, data);
if (!params.filename) await response.registerImageResult(data, fileType);
```

The agent had passed `filename=dashboard.png`. So the PNG was written into
MCP's output directory — a path nothing on our side can reach — and **no image
was returned at all**, to us or to the model. The agent's description of the
page came from an earlier `browser_snapshot`, not from a picture it had seen.

Independently, the runner's message pump read only `assistant` messages. Tool
results arrive as `user` messages, so even an image that *was* returned would
have been dropped.

## The design

Rejected: **VNC/noVNC over Xvfb** (truly live and interactive for free, but
needs headful Chromium, Xvfb, x11vnc and websockify in the runtime image, and
multiplies the per-session cost), and **WebRTC** (best bandwidth at high frame
rates, but a full video pipeline with signalling and TURN, for pages that are
mostly static text). Both are large infrastructure bets against a problem that
turned out to be four bugs in the code we already had.

Chosen: fix the CDP screencast. No new infrastructure, no change to the Docker
runtime, unchanged for the Phase 2 Expo app, and it extends directly into the
interactive phase — `Input.dispatchMouseEvent` rides the same CDP session, which
is exactly what the existing sign-in flow already does.

1. **`startScreencast` takes the context, not a page.** It attaches to every
   page and to every future one, detaching on close. Frames are forwarded from
   whichever tab is painting; the view only moves once the watched tab has been
   quiet for `switchAfterMs` (400 ms), so two live tabs cannot trade the panel
   back and forth every frame.
2. **`everyNthFrame: 1`, with a real ceiling in our own code.** A coalescing
   throttle caps output at `fps` (12) and flushes the newest pending frame on a
   trailing timer, so a burst of movement still settles on the state the page
   ended in. Chromium's own skipping is blunt — it halves a slow page as readily
   as a fast one.
3. **A heartbeat.** After `heartbeatMs` (1000) with nothing sent, capture a
   frame with `Page.captureScreenshot`, which works on any page whether or not
   it is in front. It is clipped to the visible viewport and scaled by the same
   factor Chromium applies to screencast frames, so heartbeats do not arrive at
   a different resolution from the frames around them.
4. **The newest frame is cached on the session** and replayed to each new frame
   subscriber, so opening or reloading paints at once. It is dropped on
   `restartBrowser`, where it would otherwise show a browser that no longer
   exists.
5. **`preview_state`** is sent on connect and on every change, so a reconnecting
   client's switch reflects the session rather than its own fresh default. The
   console asks for preview as soon as the socket opens.
6. **`BrowserStream`** decodes each frame to an `ImageBitmap` and draws it to a
   canvas, keeping one surface on screen and freeing each frame once drawn. Only
   the newest frame is kept while a decode is in flight.
7. **The `filename` argument is stripped** from `browser_take_screenshot` via
   `canUseTool`'s `updatedInput`, so the image comes back — and the model sees
   its own screenshots for the first time.
8. **The runner pumps `user` messages too**, pulls image blocks out of
   `tool_result`, writes them beside the session's downloads as
   `screenshot-N.png`, and emits `screenshot` with a URL. The base64 never
   touches the socket's JSON lane or the durable transcript, which would
   otherwise carry a few hundred kilobytes per picture and replay it on every
   reload. Transcript replay works through the existing file route.

Screenshots ride a distinct event from `file_ready` so they do not clutter the
Files page, which lists what the robot downloaded rather than what it looked at.

## Consequences

- Preview defaults on, which costs about 136 KiB/s while a page is animating and
  near nothing when it is static. Fine for the web console; worth revisiting for
  the mobile app, where the toggle and the fps ceiling are the levers.
- Screenshots share the session's downloads directory. They persist with the
  session and are served `content-disposition: inline` so opening one shows it.
- `remote-browser.tsx`, the two-way panel used for signing in, still swaps an
  `<img>` per frame. It should adopt `BrowserStream`; it was left alone here
  only because it had uncommitted changes in flight.
