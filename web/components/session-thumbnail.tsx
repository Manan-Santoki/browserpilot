"use client";

import { useEffect, useRef } from "react";
import { BrowserStream, type BrowserStreamHandle } from "@/components/browser-stream";

/**
 * A small, read-only subscriber to the session's existing screencast. The
 * runtime immediately replays its latest frame, so cards paint without waiting
 * for the browser to change. BrowserStream keeps the canvas stable between
 * frames, which also keeps thumbnails from flashing.
 */
export function SessionThumbnail({ sessionId }: { sessionId: string }) {
  const streamRef = useRef<BrowserStreamHandle | null>(null);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    async function connect() {
      const res = await fetch(`/api/sessions/${sessionId}/ticket`, { method: "POST" });
      if (!res.ok || closed) return;

      const { url } = (await res.json()) as { url: string };
      if (closed) return;

      socket = new WebSocket(url);
      socket.binaryType = "blob";
      socket.onmessage = (event) => {
        if (event.data instanceof Blob) streamRef.current?.push(event.data);
      };
    }

    void connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [sessionId]);

  return (
    <BrowserStream
      ref={streamRef}
      className="bg-background mt-3 aspect-[16/10] w-full rounded-md border"
      placeholder="Waiting for the latest frame…"
    />
  );
}
