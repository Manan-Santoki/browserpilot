"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusLabel } from "@/components/status-lamp";
import { AgentMarkdown } from "@/components/agent-markdown";
import { PushToTalk } from "./push-to-talk";

import type { ChatItem } from "@/lib/transcript";

type Props = {
  sessionId: string;
  runtimeHttpUrl: string;
  language: string;
  /** The conversation so far, read from the database on the server. */
  initialItems: ChatItem[];
};

export function LiveSession({ sessionId, runtimeHttpUrl, language, initialItems }: Props) {
  // Seeded from the transcript so a reload shows the conversation, and any
  // approval still waiting for an answer is there to answer.
  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [status, setStatus] = useState("connecting");
  const [ended, setEnded] = useState<{ reason: string | null } | null>(null);
  const [connected, setConnected] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const frameUrlRef = useRef<string | null>(null);

  const append = useCallback((item: ChatItem) => setItems((prev) => [...prev, item]), []);

  const [reconnectNonce, setReconnectNonce] = useState(0);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    /**
     * A closed socket usually means the session ended — stopped, timed out, or
     * failed — so ask the console why before reporting anything to the user.
     * Showing "disconnected" for a session that was deliberately stopped reads
     * as a bug in the app rather than the outcome the user asked for.
     */
    async function explainClosure() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return false;
        const body = (await res.json()) as { status: string; endedReason: string | null };
        if (["stopped", "failed", "interrupted"].includes(body.status)) {
          setEnded({ reason: body.endedReason });
          setStatus(body.status);
          return true;
        }
      } catch {
        // Leave the generic disconnected state.
      }
      return false;
    }

    async function connect() {
      const res = await fetch(`/api/sessions/${sessionId}/ticket`, { method: "POST" });
      if (!res.ok) {
        if (!(await explainClosure())) {
          setStatus("cannot connect");
          append({ kind: "error", text: "Could not get permission to connect to this session." });
        }
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
        if (closed) return; // we navigated away; nothing to explain
        void explainClosure().then((explained) => {
          if (!explained) setStatus((s) => (s === "stopped" ? s : "disconnected"));
        });
      };
      socket.onerror = () => setConnected(false);

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
            if (["stopped", "failed", "interrupted"].includes(msg.status)) {
              setEnded({ reason: null });
            }
            break;
          case "error":
            append({ kind: "error", text: msg.message });
            break;
          case "file_ready":
            // msg.url is runtime-relative; the console proxies it so the link
            // carries the user's cookie instead of needing a ticket.
            append({ kind: "file", filename: msg.filename, url: msg.url });
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
  }, [sessionId, runtimeHttpUrl, append, reconnectNonce]);

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

  const togglePreview = (checked?: boolean) => {
    const next = checked ?? !previewOn;
    setPreviewOn(next);
    wsRef.current?.send(JSON.stringify({ type: "preview", enabled: next }));
  };

  const busy = status === "working" || status === "starting";

  if (ended) {
    return (
      <Card className="px-6 py-12 text-center">
        <p className="text-sm">
          This session has ended{ended.reason ? `: ${ended.reason}` : "."}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Reload to read the conversation and files it left behind.
        </p>
        <div className="mt-4">
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="flex h-[72vh] flex-col gap-0 overflow-hidden py-0">
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <StatusLabel status={connected ? status : "disconnected"} />
          {!connected ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => {
                setStatus("connecting");
                setReconnectNonce((n) => n + 1);
              }}
            >
              Reconnect
            </Button>
          ) : null}
        </header>

        <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
          {items.length === 0 ? (
            <p className="text-muted-foreground">
              Tell the robot what to do. It asks when something is ambiguous, and waits for you
              before anything destructive.
            </p>
          ) : null}

          {items.map((item, i) => {
            if (item.kind === "you") {
              return (
                <p key={i} className="text-right">
                  <span className="bg-secondary text-secondary-foreground inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-left">
                    {item.text}
                  </span>
                </p>
              );
            }
            if (item.kind === "agent") {
              return <AgentMarkdown key={i}>{item.text}</AgentMarkdown>;
            }
            if (item.kind === "tool") {
              // The activity feed is a machine log, so it is set as one — mono,
              // dim, and visually distinct from the agent's prose above it.
              return (
                <p key={i} className="text-muted-foreground/80 font-mono text-xs">
                  <span className="text-muted-foreground/50 mr-2">›</span>
                  {item.text}
                </p>
              );
            }
            if (item.kind === "error") {
              return (
                <p key={i} className="text-destructive">
                  {item.text}
                </p>
              );
            }
            if (item.kind === "file") {
              return (
                <p key={i}>
                  <a
                    href={item.url}
                    className="bg-secondary hover:bg-accent inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs transition-colors"
                  >
                    <span aria-hidden>↓</span>
                    {item.filename}
                  </a>
                </p>
              );
            }
            return (
              <div
                key={i}
                className="border-signal/40 bg-signal/5 rounded-lg border px-3 py-2.5"
              >
                <p className="text-signal font-medium">Waiting for you</p>
                <p className="text-foreground/90 mt-1 font-mono text-xs break-all">
                  {item.summary}
                </p>
                {item.resolved ? (
                  <p className="text-muted-foreground mt-2 text-xs">{item.resolved}</p>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => respond(item.requestId, true)}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => respond(item.requestId, false)}
                    >
                      Deny
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <form onSubmit={send} className="flex items-center gap-2 border-t p-3">
          <PushToTalk
            language={language}
            disabled={!connected}
            onTranscript={(text) => setDraft((d) => (d ? `${d} ${text}` : text))}
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!connected}
            placeholder={
              !connected
                ? "Not connected"
                : busy
                  ? "Working — anything you send now goes next"
                  : "Tell the robot what to do…"
            }
            className="flex-1"
          />
          <Button type="submit" disabled={!connected || !draft.trim()}>
            Send
          </Button>
        </form>
      </Card>

      <Card className="flex h-[72vh] flex-col gap-0 overflow-hidden py-0">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            Browser
          </span>
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <Switch checked={previewOn} onCheckedChange={togglePreview} disabled={!connected} />
            Live preview
          </label>
        </header>

        <div className="bg-background flex flex-1 items-center justify-center overflow-hidden">
          {frameUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={frameUrl} alt="Live browser" className="max-h-full max-w-full object-contain" />
          ) : (
            <p className="text-muted-foreground px-6 text-center text-sm">
              {previewOn
                ? "Waiting for the first frame…"
                : "Turn on live preview to watch the browser."}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
