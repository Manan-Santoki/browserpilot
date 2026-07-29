"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PushToTalk } from "./push-to-talk";

type ChatItem =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | { kind: "file"; filename: string; url: string }
  | { kind: "approval"; requestId: string; summary: string; resolved?: "approved" | "denied" };

type Props = { sessionId: string; runtimeHttpUrl: string; language: string };

export function LiveSession({ sessionId, runtimeHttpUrl, language }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState("connecting");
  const [connected, setConnected] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  const append = useCallback((item: ChatItem) => setItems((prev) => [...prev, item]), []);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    async function connect() {
      const res = await fetch(`/api/sessions/${sessionId}/ticket`, { method: "POST" });
      if (!res.ok) {
        setStatus("cannot connect");
        append({ kind: "error", text: "Could not get permission to connect to this session." });
        return;
      }

      const { url } = (await res.json()) as { url: string };
      if (closed) return;

      socket = new WebSocket(url);
      socket.binaryType = "blob";
      wsRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        setStatus((s) => (s === "stopped" ? s : "disconnected"));
      };

      socket.onmessage = (event) => {
        if (event.data instanceof Blob) {
          // Release the previous frame or the tab leaks memory over a long run.
          if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
          const next = URL.createObjectURL(event.data);
          frameUrlRef.current = next;
          setFrameUrl(next);
          return;
        }

        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "agent_text":
            append({ kind: "agent", text: msg.text });
            break;
          case "tool_activity":
            append({ kind: "tool", text: msg.summary });
            break;
          case "session_status":
            setStatus(msg.status);
            break;
          case "error":
            append({ kind: "error", text: msg.message });
            break;
          case "file_ready":
            append({ kind: "file", filename: msg.filename, url: `${runtimeHttpUrl}${msg.url}` });
            break;
          case "approval_request":
            append({ kind: "approval", requestId: msg.requestId, summary: msg.summary });
            break;
          case "approval_resolved":
            setItems((prev) =>
              prev.map((item) =>
                item.kind === "approval" && item.requestId === msg.requestId
                  ? { ...item, resolved: msg.approved ? "approved" : "denied" }
                  : item,
              ),
            );
            break;
        }
      };
    }

    void connect();

    return () => {
      closed = true;
      socket?.close();
      if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
    };
  }, [sessionId, runtimeHttpUrl, append]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items]);

  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "user_msg", text }));
    append({ kind: "you", text });
    setDraft("");
  };

  const respond = (requestId: string, approved: boolean) => {
    wsRef.current?.send(JSON.stringify({ type: "approval", requestId, approved }));
  };

  const togglePreview = () => {
    const next = !previewOn;
    setPreviewOn(next);
    wsRef.current?.send(JSON.stringify({ type: "preview", enabled: next }));
  };

  const busy = status === "working" || status === "starting";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="flex h-[70vh] flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
        <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5 text-sm dark:border-neutral-800">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              status === "awaiting_approval"
                ? "bg-amber-500"
                : busy
                  ? "animate-pulse bg-green-500"
                  : connected
                    ? "bg-neutral-400"
                    : "bg-red-500"
            }`}
          />
          <span className="text-neutral-600 dark:text-neutral-300">{status}</span>
        </header>

        <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
          {items.length === 0 ? (
            <p className="text-neutral-400">
              Tell the robot what to do. It will ask if something is ambiguous, and wait for your
              approval before anything destructive.
            </p>
          ) : null}

          {items.map((item, i) => {
            if (item.kind === "you") {
              return (
                <p key={i} className="text-right">
                  <span className="inline-block rounded-lg bg-neutral-900 px-3 py-1.5 text-white dark:bg-white dark:text-neutral-900">
                    {item.text}
                  </span>
                </p>
              );
            }
            if (item.kind === "agent") {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {item.text}
                </p>
              );
            }
            if (item.kind === "tool") {
              return (
                <p key={i} className="text-xs text-neutral-400">
                  {item.text}
                </p>
              );
            }
            if (item.kind === "status") {
              return (
                <p key={i} className="text-xs text-blue-600 dark:text-blue-400">
                  {item.text}
                </p>
              );
            }
            if (item.kind === "error") {
              return (
                <p key={i} className="text-red-600 dark:text-red-400">
                  {item.text}
                </p>
              );
            }
            if (item.kind === "file") {
              return (
                <p key={i}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    ⬇ {item.filename}
                  </a>
                </p>
              );
            }
            return (
              <div
                key={i}
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700/60 dark:bg-amber-950/40"
              >
                <p className="font-medium">Approval needed</p>
                <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">{item.summary}</p>
                {item.resolved ? (
                  <p className="mt-1 text-xs text-neutral-500">{item.resolved}</p>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => respond(item.requestId, true)}
                      className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => respond(item.requestId, false)}
                      className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium dark:border-neutral-600"
                    >
                      Deny
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <form onSubmit={send} className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <PushToTalk
            language={language}
            disabled={!connected}
            onTranscript={(text) => setDraft((d) => (d ? `${d} ${text}` : text))}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!connected}
            placeholder={connected ? "Tell the robot what to do…" : "Not connected"}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={!connected || !draft.trim()}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            Send
          </button>
        </form>
      </section>

      <section className="flex h-[70vh] flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-300">Browser</span>
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={previewOn}
              onChange={togglePreview}
              disabled={!connected}
            />
            Live preview
          </label>
        </header>

        <div className="flex flex-1 items-center justify-center overflow-hidden bg-neutral-950">
          {frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={frameUrl} alt="Live browser" className="max-h-full max-w-full object-contain" />
          ) : (
            <p className="px-6 text-center text-sm text-neutral-500">
              {previewOn
                ? "Waiting for the first frame…"
                : "Turn on live preview to watch the browser."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
