"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserStream, type BrowserStreamHandle } from "@/components/browser-stream";

type Props = {
  sessionId: string;
  /** Called once the socket is open, so the page can enable Save. */
  onReady?: (ready: boolean) => void;
};

/**
 * A browser you can actually use, running on the server.
 *
 * The session preview elsewhere in the console is a one-way video of what the
 * robot is doing. This is the same stream with the arrows reversed: clicks,
 * scrolls and keystrokes are sent back to Chromium, so a person can sign in to
 * a target site with their own hands — password manager, one-time code, SSO
 * redirect and all.
 *
 * Coordinates go over the wire as a fraction of the viewport rather than as
 * pixels. The frame is scaled to whatever space the layout gives it, and only
 * the browser knows its real viewport, so anything else would land the click in
 * the wrong place at some window size.
 */
export function RemoteBrowser({ sessionId, onReady }: Props) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<BrowserStreamHandle | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback((event: unknown) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", event }));
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    async function connect() {
      const res = await fetch(`/api/sessions/${sessionId}/ticket`, { method: "POST" });
      if (!res.ok) {
        setError("Could not connect to the sign-in browser. It may have already closed.");
        return;
      }
      const { url } = (await res.json()) as { url: string };
      if (closed) return;

      socket = new WebSocket(url);
      socket.binaryType = "blob";
      wsRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        onReady?.(true);
      };
      socket.onclose = () => {
        setConnected(false);
        onReady?.(false);
      };
      socket.onmessage = (event) => {
        if (event.data instanceof Blob) streamRef.current?.push(event.data);
      };
    }

    void connect();

    return () => {
      closed = true;
      socket?.close();
    };
  }, [sessionId, onReady]);

  /**
   * Where in the viewport this pointer event landed, as a 0–1 fraction.
   *
   * Kept inside a callback rather than called while rendering: the surface is
   * only measurable once it is on screen, and only an event can ask for it.
   */
  const handleMouse = useCallback(
    (
      action: "move" | "down" | "up" | "wheel",
      event: { clientX: number; clientY: number; detail?: number },
      extra: Record<string, number> = {},
    ) => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const box = surface.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;

      send({
        kind: "mouse",
        action,
        x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
        y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
        button: "left",
        clickCount: event.detail || 1,
        ...extra,
      });
    },
    [send],
  );

  const onMouseDown = (event: React.MouseEvent) => {
    // Deliberately no preventDefault: cancelling mousedown also cancels the
    // focus it would move here, and without focus this element never sees a
    // keystroke. Focus it explicitly so a click is enough to start typing.
    surfaceRef.current?.focus({ preventScroll: true });
    handleMouse("down", event);
  };
  const onMouseUp = (event: React.MouseEvent) => handleMouse("up", event);
  const onMouseMove = (event: React.MouseEvent) => handleMouse("move", event);
  const onWheel = (event: React.WheelEvent) =>
    handleMouse("wheel", event, { deltaX: event.deltaX, deltaY: event.deltaY });

  const onKeyDown = (event: React.KeyboardEvent) => {
    // While this surface has focus every key belongs to the remote page, so the
    // console must not also act on it — Space and the arrows would scroll this
    // page, Tab would move focus out, Backspace can navigate back. Shortcuts
    // held with Ctrl or Cmd are left alone so the browser's own still work.
    // Ctrl and Cmd combinations are left to this tab, both so its own
    // shortcuts work and so a paste reaches onPaste below.
    if (!event.ctrlKey && !event.metaKey) event.preventDefault();

    const modifiers =
      (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

    send({
      kind: "key",
      action: "down",
      key: event.key,
      code: event.code,
      // Only printable keys carry text; sending it for Enter types a newline.
      text: event.key.length === 1 ? event.key : undefined,
      modifiers,
    });
  };

  const onKeyUp = (event: React.KeyboardEvent) => {
    send({ kind: "key", action: "up", key: event.key, code: event.code });
  };

  /**
   * Ctrl+V is handled by the browser you are sitting at, not by the remote
   * page, so the keystrokes alone paste nothing. The clipboard text arrives
   * here instead and is inserted as a single edit — which is also what a
   * password manager's paste looks like.
   */
  const onPaste = (event: React.ClipboardEvent) => {
    const text = event.clipboardData.getData("text");
    if (!text) return;
    event.preventDefault();
    send({ kind: "text", text });
  };

  return (
    <div className="space-y-2">
      <div
        ref={surfaceRef}
        role="application"
        aria-label="Remote browser"
        tabIndex={0}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onContextMenu={(e) => e.preventDefault()}
        className={`bg-secondary relative aspect-[16/10] max-h-[78vh] w-full cursor-default overflow-hidden rounded-lg border outline-none transition-colors ${
          focused ? "border-signal ring-signal/20 ring-3" : "border-border"
        }`}
      >
        <BrowserStream
          ref={streamRef}
          className="pointer-events-none h-full w-full"
          placeholder={error ?? (connected ? "Waiting for the page…" : "Opening a browser…")}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        {error
          ? error
          : focused
            ? "Typing goes to the remote browser."
            : "Click the page above, then type as you normally would."}
      </p>
    </div>
  );
}
