"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { StatusLabel } from "@/components/status-lamp";
import { SendIcon } from "lucide-react";
import { AgentMarkdown } from "@/components/agent-markdown";
import { BrowserStream, type BrowserStreamHandle } from "@/components/browser-stream";
import { PushToTalk } from "./push-to-talk";
import {
  LiveVoice,
  type LiveVoiceHandle,
  type LiveVoiceTranscript,
  type VoiceCommandResult,
} from "./live-voice";

import type { ChatItem } from "@/lib/transcript";

type Props = {
  sessionId: string;
  runtimeHttpUrl: string;
  language: string;
  /** The conversation so far, read from the database on the server. */
  initialItems: ChatItem[];
  /** Watching, not driving: composer, approvals and Stop are hidden. */
  readOnly?: boolean;
  /** Who owns the session, for the read-only banner. */
  ownerName?: string;
};

export function LiveSession({
  sessionId,
  runtimeHttpUrl,
  language,
  initialItems,
  readOnly = false,
  ownerName,
}: Props) {
  // Seeded from the transcript so a reload shows the conversation, and any
  // approval still waiting for an answer is there to answer.
  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [status, setStatus] = useState("connecting");
  const [ended, setEnded] = useState<{ reason: string | null } | null>(null);
  const [connected, setConnected] = useState(false);
  const [previewOn, setPreviewOn] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [draft, setDraft] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<BrowserStreamHandle | null>(null);
  const liveVoiceRef = useRef<LiveVoiceHandle | null>(null);
  // Gemini can flush the user's speech and its reply in the same tick. Keep
  // writes serialized so the durable event sequence still matches what the
  // user heard.
  const voiceTranscriptWriteRef = useRef<Promise<void>>(Promise.resolve());
  const voiceWaitersRef = useRef(
    new Map<
      string,
      {
        resolve: (result: VoiceCommandResult) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );

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

      const opened = new WebSocket(url);
      socket = opened;
      opened.binaryType = "blob";
      wsRef.current = opened;

      opened.onopen = () => {
        setConnected(true);
        // A panel you have to switch on is a panel that looks dead. Ask for
        // frames straight away; the switch is there to stop them, not start them.
        opened.send(JSON.stringify({ type: "preview", enabled: true }));
      };
      opened.onclose = () => {
        setConnected(false);
        for (const waiter of voiceWaitersRef.current.values()) {
          clearTimeout(waiter.timer);
          waiter.resolve({
            ok: false,
            status: "failed",
            message: "The browser session disconnected before it answered.",
          });
        }
        voiceWaitersRef.current.clear();
        if (closed) return; // we navigated away; nothing to explain
        void explainClosure().then((explained) => {
          if (!explained) setStatus((s) => (s === "stopped" ? s : "disconnected"));
        });
      };
      opened.onerror = () => setConnected(false);

      opened.onmessage = (event) => {
        if (event.data instanceof Blob) {
          streamRef.current?.push(event.data);
          return;
        }

        const msg = JSON.parse(event.data as string);
        liveVoiceRef.current?.handleRuntimeEvent(msg);
        switch (msg.type) {
          case "user_msg":
            append({ kind: "you", text: msg.text });
            break;
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
            setItems((prev) => {
              const alreadyShown = prev.some(
                (item) =>
                  item.kind === "file" &&
                  (item.url === msg.url || item.filename === msg.filename),
              );
              return alreadyShown
                ? prev
                : [...prev, { kind: "file", filename: msg.filename, url: msg.url }];
            });
            break;
          case "screenshot":
            append({ kind: "screenshot", filename: msg.filename, url: msg.url });
            break;
          case "preview_state":
            setPreviewOn(msg.enabled);
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
          case "choice_request":
            append({
              kind: "choice",
              requestId: msg.requestId,
              question: msg.question,
              options: msg.options,
            });
            break;
          case "choice_resolved":
            setItems((prev) =>
              prev.map((item) =>
                item.kind === "choice" && item.requestId === msg.requestId
                  ? {
                      ...item,
                      resolved: { value: msg.value, label: msg.label },
                    }
                  : item,
              ),
            );
            break;
          case "voice_command_result": {
            const waiter = voiceWaitersRef.current.get(msg.requestId);
            if (waiter) {
              clearTimeout(waiter.timer);
              voiceWaitersRef.current.delete(msg.requestId);
              waiter.resolve({
                ok: Boolean(msg.ok),
                status: msg.status,
                message: msg.message,
              });
            }
            break;
          }
        }
      };
    }

    void connect();

    return () => {
      closed = true;
      socket?.close();
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

  const choose = (requestId: string, value: string) => {
    wsRef.current?.send(JSON.stringify({ type: "choice", requestId, value }));
  };

  const sendVoiceCommand = useCallback(
    (
      command:
        | { type: "voice_task_start"; requestId: string; text: string }
        | { type: "agent_interrupt"; requestId: string },
    ): Promise<VoiceCommandResult> =>
      new Promise((resolve) => {
        const socket = wsRef.current;
        if (socket?.readyState !== WebSocket.OPEN) {
          resolve({
            ok: false,
            status: "failed",
            message: "The browser session is not connected.",
          });
          return;
        }
        const timer = setTimeout(() => {
          voiceWaitersRef.current.delete(command.requestId);
          resolve({
            ok: false,
            status: "failed",
            message: "The browser agent did not acknowledge the voice command.",
          });
        }, 5_000);
        voiceWaitersRef.current.set(command.requestId, { resolve, timer });
        socket.send(JSON.stringify(command));
      }),
    [],
  );

  const submitVoiceChoice = useCallback((requestId: string, optionId: string) => {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "choice", requestId, value: optionId }));
    return true;
  }, []);

  const recordVoiceTranscript = useCallback(
    (message: LiveVoiceTranscript) => {
      append({
        kind: message.speaker === "assistant" ? "voice_assistant" : "voice_user",
        text: message.text,
        inputModality: message.inputModality,
        outputModality: message.outputModality,
      });

      voiceTranscriptWriteRef.current = voiceTranscriptWriteRef.current
        .catch(() => {
          // A failed message must not prevent later transcript writes.
        })
        .then(async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const response = await fetch(`/api/sessions/${sessionId}/transcript`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ kind: "transcript", ...message }),
              });
              if (response.ok) return;
            } catch {
              // Retry below. The message remains visible locally in the meantime.
            }
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
          }
          console.error("[live_voice] transcript.save_failed", message.messageId);
        });
    },
    [append, sessionId],
  );

  const logVoiceTelemetry = useCallback(
    (event: string, detail?: string, level: "info" | "warn" | "error" = "info") => {
      void fetch(`/api/sessions/${sessionId}/transcript`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "telemetry", event, detail, level }),
      }).catch(() => {});
    },
    [sessionId],
  );

  // Identity-stable, so resizing does not tear down the observer each render.
  const reportSize = useCallback((cssWidth: number, pixelRatio: number) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "viewport", cssWidth, pixelRatio }));
    }
  }, []);

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

  // The browser is what this page is for, so it takes the room and the chat
  // gets a column beside it. Below lg they stack, browser first — on a phone
  // you scroll to the conversation, you do not hunt for the screen.
  return (
    <div
      className={`grid min-h-0 flex-1 items-stretch gap-4 lg:min-h-[480px] ${
        chatOpen ? "lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]" : ""
      }`}
    >
      <Card className="order-1 flex min-h-0 flex-col gap-0 overflow-hidden py-0 max-lg:h-auto">
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            Browser
          </span>
          <div className="flex items-center gap-4">
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              <Switch checked={previewOn} onCheckedChange={togglePreview} disabled={!connected} />
              Live preview
            </label>
            <Button
              size="sm"
              variant="ghost"
              className="max-lg:hidden"
              onClick={() => setChatOpen((open) => !open)}
              title={chatOpen ? "Give the browser the whole width" : "Show the conversation"}
            >
              {chatOpen ? "Widen" : "Show chat"}
            </Button>
          </div>
        </header>

        {/* Fills the panel; the canvas scales the frame into it and keeps its
            shape, so nothing overflows and nothing is cropped. */}
        <BrowserStream
          ref={streamRef}
          onDisplaySize={reportSize}
          className="bg-background min-h-0 w-full flex-1 max-lg:aspect-[16/10]"
          placeholder={
            previewOn ? "Waiting for the first frame…" : "Turn on live preview to watch the browser."
          }
        />
      </Card>

      <Card
        className={`order-2 flex min-h-0 flex-col gap-0 overflow-hidden py-0 max-lg:h-[70vh] ${
          chatOpen ? "" : "lg:hidden"
        }`}
      >
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <StatusLabel status={connected ? status : "disconnected"} live={connected} />
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

        <div ref={logRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
          {items.length === 0 ? (
            <p className="text-muted-foreground">
              {readOnly
                ? "Watching this session live. Its owner drives the browser; you can read along."
                : "Tell the robot what to do. It asks when something is ambiguous, and waits for you before anything destructive."}
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
            if (item.kind === "voice_user") {
              return (
                <div key={i} className="text-right">
                  <p className="text-muted-foreground mb-1 text-[10px] tracking-wide uppercase">
                    Voice · {item.inputModality} → {item.outputModality}
                  </p>
                  <p className="bg-secondary text-secondary-foreground inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-left">
                    {item.text}
                  </p>
                </div>
              );
            }
            if (item.kind === "voice_assistant") {
              return (
                <div key={i} className="border-signal/25 bg-signal/5 rounded-lg border px-3 py-2">
                  <p className="text-signal mb-1 text-[10px] tracking-wide uppercase">
                    Gemini Live · {item.inputModality} → {item.outputModality}
                  </p>
                  <AgentMarkdown>{item.text}</AgentMarkdown>
                </div>
              );
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
            if (item.kind === "screenshot") {
              // Asking for a screenshot and getting a download link back is not
              // an answer, so it is shown — full size is one click away.
              return (
                <a key={i} href={item.url} target="_blank" rel="noreferrer" className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={`Screenshot of the page — ${item.filename}`}
                    className="max-h-72 w-auto rounded-lg border transition-opacity hover:opacity-90"
                  />
                </a>
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
            if (item.kind === "choice") {
              const selected = item.resolved
                ? item.options.find((option) => option.value === item.resolved?.value)
                : undefined;
              return (
                <div
                  key={i}
                  className="border-signal/40 bg-signal/5 rounded-lg border px-3 py-3"
                >
                  <p className="text-signal text-xs font-medium tracking-wide uppercase">
                    Choose one
                  </p>
                  <p className="text-foreground mt-1.5 text-sm">{item.question}</p>
                  <Select
                    items={item.options}
                    value={item.resolved?.value ?? null}
                    disabled={Boolean(item.resolved) || !connected || readOnly}
                    onValueChange={(value) => {
                      if (value) choose(item.requestId, value);
                    }}
                  >
                    <SelectTrigger className="mt-3 w-full" aria-label={item.question}>
                      <SelectValue placeholder="Select an option…" />
                    </SelectTrigger>
                    <SelectContent align="start">
                      {item.options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selected?.description ? (
                    <p className="text-muted-foreground mt-2 text-xs">
                      {selected.description}
                    </p>
                  ) : null}
                  {item.resolved ? (
                    <p className="text-muted-foreground mt-2 text-xs">
                      Selected: {item.resolved.label}
                    </p>
                  ) : null}
                </div>
              );
            }
            return (
              <div
                key={i}
                className="border-signal/40 bg-signal/5 rounded-lg border px-3 py-2.5"
              >
                <p className="text-signal font-medium">
                  {readOnly ? "Waiting for the owner" : "Waiting for you"}
                </p>
                <p className="text-foreground/90 mt-1 font-mono text-xs break-all">
                  {item.summary}
                </p>
                {item.resolved ? (
                  <p className="text-muted-foreground mt-2 text-xs">{item.resolved}</p>
                ) : readOnly ? (
                  <p className="text-muted-foreground mt-2 text-xs">
                    {ownerName ?? "The owner"} will decide this one.
                  </p>
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

        {readOnly ? (
          <div className="border-muted flex shrink-0 items-center gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
            Watching{ownerName ? ` ${ownerName}'s` : ""} session — you can&apos;t type, approve, or
            stop it.
          </div>
        ) : (
        <form onSubmit={send} className="flex shrink-0 items-center gap-2 border-t p-2.5">
          <LiveVoice
            ref={liveVoiceRef}
            sessionId={sessionId}
            runtimeConnected={connected}
            runtimeStatus={status}
            startBrowserTask={(requestId, instruction) =>
              sendVoiceCommand({
                type: "voice_task_start",
                requestId,
                text: instruction,
              })
            }
            interruptBrowserTask={(requestId) =>
              sendVoiceCommand({ type: "agent_interrupt", requestId })
            }
            submitChoice={submitVoiceChoice}
            recordTranscript={recordVoiceTranscript}
            logTelemetry={logVoiceTelemetry}
          />
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
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            title="Send"
            disabled={!connected || !draft.trim()}
          >
            <SendIcon />
          </Button>
        </form>
        )}
      </Card>
    </div>
  );
}
