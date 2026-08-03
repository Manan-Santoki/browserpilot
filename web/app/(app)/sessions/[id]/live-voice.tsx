"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AudioLinesIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  GeminiLiveClient,
  type GeminiFunctionCall,
  type GeminiLiveToken,
} from "@/lib/gemini-live";
import { WebLiveAudio } from "@/lib/web-live-audio";

export type VoiceCommandResult = {
  ok: boolean;
  status: "accepted" | "busy" | "idle" | "invalid" | "failed";
  message: string;
};

export type LiveVoiceTranscript = {
  messageId: string;
  speaker: "user" | "assistant";
  text: string;
  inputModality: "text" | "audio";
  outputModality: "text" | "audio";
};

type RuntimeEvent = {
  type?: string;
  status?: string;
  text?: string;
  summary?: string;
  message?: string;
  requestId?: string;
  question?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  outcome?: string;
  voiceTaskId?: string;
};

export type LiveVoiceHandle = {
  handleRuntimeEvent(event: RuntimeEvent): void;
  stop(): void;
};

type Props = {
  sessionId: string;
  runtimeConnected: boolean;
  runtimeStatus: string;
  startBrowserTask: (requestId: string, instruction: string) => Promise<VoiceCommandResult>;
  interruptBrowserTask: (requestId: string) => Promise<VoiceCommandResult>;
  submitChoice: (requestId: string, optionId: string) => boolean;
  recordTranscript: (message: LiveVoiceTranscript) => void;
  logTelemetry: (
    event: string,
    detail?: string,
    level?: "info" | "warn" | "error",
  ) => void;
};

type VoiceState =
  | "off"
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "error";

function runtimeRequestId(call: GeminiFunctionCall): string {
  const safe = call.id.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 180);
  return `gemini_${safe || crypto.randomUUID()}`;
}

function mergeTranscriptChunk(current: string, chunk: string): string {
  const next = chunk.trim();
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let length = maxOverlap; length >= 3; length -= 1) {
    if (current.slice(-length) === next.slice(0, length)) {
      return `${current}${next.slice(length)}`;
    }
  }
  return `${current}${/^[,.;!?]/.test(next) ? "" : " "}${next}`;
}

export const LiveVoice = forwardRef<LiveVoiceHandle, Props>(function LiveVoice(
  {
    sessionId,
    runtimeConnected,
    runtimeStatus,
    startBrowserTask,
    interruptBrowserTask,
    submitChoice,
    recordTranscript,
    logTelemetry,
  },
  ref,
) {
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const audioRef = useRef<WebLiveAudio | null>(null);
  const choicesRef = useRef(
    new Map<string, Array<{ label: string; value: string; description?: string }>>(),
  );
  const runtimeStatusRef = useRef(runtimeStatus);
  const runtimeConnectedRef = useRef(runtimeConnected);
  const lastToolUpdateRef = useRef(0);
  const stateRef = useRef<VoiceState>("off");
  const startAttemptRef = useRef(0);
  const inputTranscriptRef = useRef("");
  const outputTranscriptRef = useRef("");
  const turnInputModalityRef = useRef<"text" | "audio">("audio");
  const transcriptCounterRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingAgentTextRef = useRef("");

  useEffect(() => {
    runtimeStatusRef.current = runtimeStatus;
    runtimeConnectedRef.current = runtimeConnected;
  }, [runtimeStatus, runtimeConnected]);

  const updateState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setVoiceState(next);
  }, []);

  const telemetry = useCallback(
    (event: string, detail?: string, level: "info" | "warn" | "error" = "info") => {
      const method = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      method("[live_voice]", event, detail ?? "");
      logTelemetry(event, detail, level);
    },
    [logTelemetry],
  );

  const flushTranscripts = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = undefined;
    const input = inputTranscriptRef.current.trim();
    const output = outputTranscriptRef.current.trim();
    const inputModality = turnInputModalityRef.current;
    inputTranscriptRef.current = "";
    outputTranscriptRef.current = "";
    turnInputModalityRef.current = "audio";

    const save = (
      speaker: "user" | "assistant",
      text: string,
      sourceInputModality: "text" | "audio",
    ) => {
      transcriptCounterRef.current += 1;
      const message: LiveVoiceTranscript = {
        messageId: `voice_${Date.now()}_${transcriptCounterRef.current}`,
        speaker,
        text,
        inputModality: sourceInputModality,
        outputModality: "audio",
      };
      console.info("[live_voice] transcript", {
        speaker,
        inputModality: sourceInputModality,
        outputModality: "audio",
        text,
      });
      recordTranscript(message);
      telemetry(
        "transcript.recorded",
        `speaker=${speaker} input=${sourceInputModality} output=audio chars=${text.length}`,
      );
    };

    if (input) save("user", input, "audio");
    if (output) save("assistant", output, inputModality);
    setTranscript("");
  }, [recordTranscript, telemetry]);

  const stop = useCallback(() => {
    const wasActive =
      stateRef.current !== "off" ||
      clientRef.current !== null ||
      audioRef.current !== null;
    startAttemptRef.current += 1;
    flushTranscripts();
    if (wasActive) telemetry("voice.stop");
    clientRef.current?.endAudioStream();
    clientRef.current?.close();
    clientRef.current = null;
    void audioRef.current?.stop();
    audioRef.current = null;
    setTranscript("");
    setError("");
    updateState("off");
  }, [flushTranscripts, telemetry, updateState]);

  const handleToolCalls = useCallback(
    async (calls: GeminiFunctionCall[]) => {
      const responses: Array<{
        id: string;
        name: string;
        response: Record<string, unknown>;
      }> = [];

      for (const call of calls) {
        let output: Record<string, unknown>;
        const requestId = runtimeRequestId(call);
        try {
          telemetry("tool.call", call.name);
          if (call.name === "browser_task_start") {
            const instruction =
              typeof call.args?.instruction === "string" ? call.args.instruction.trim() : "";
            output = instruction
              ? await startBrowserTask(requestId, instruction)
              : { ok: false, status: "invalid", message: "A browser instruction is required." };
          } else if (call.name === "browser_task_interrupt") {
            output = await interruptBrowserTask(requestId);
          } else if (call.name === "browser_choice_submit") {
            const choiceRequest =
              typeof call.args?.requestId === "string" ? call.args.requestId : "";
            const optionId = typeof call.args?.optionId === "string" ? call.args.optionId : "";
            const options = choicesRef.current.get(choiceRequest);
            const valid = options?.some((option) => option.value === optionId) ?? false;
            output =
              valid && submitChoice(choiceRequest, optionId)
                ? { ok: true, status: "accepted", message: "The choice was submitted." }
                : {
                    ok: false,
                    status: "invalid",
                    message: "That choice is no longer active or the option was not valid.",
                  };
          } else if (call.name === "browser_status_get") {
            output = {
              ok: true,
              connected: runtimeConnectedRef.current,
              status: runtimeStatusRef.current,
            };
          } else {
            output = { ok: false, status: "invalid", message: "Unknown BrowserPilot function." };
          }
        } catch (toolError) {
          output = { ok: false, status: "failed", message: (toolError as Error).message };
        }
        telemetry(
          "tool.result",
          `${call.name} status=${typeof output.status === "string" ? output.status : "ok"}`,
        );
        responses.push({
          id: call.id,
          name: call.name,
          response: { output },
        });
      }
      return responses;
    },
    [interruptBrowserTask, startBrowserTask, submitChoice, telemetry],
  );

  const start = useCallback(async () => {
    if (!runtimeConnected) {
      setError("Reconnect the browser session before starting Live Voice.");
      updateState("error");
      return;
    }
    if (stateRef.current !== "off" && stateRef.current !== "error") return;

    setError("");
    updateState("connecting");
    telemetry("voice.start");
    const startAttempt = ++startAttemptRef.current;
    const audio = new WebLiveAudio();
    audioRef.current = audio;

    const tokenProvider = async (): Promise<GeminiLiveToken> => {
      const response = await fetch(`/api/sessions/${sessionId}/live-token`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as GeminiLiveToken & {
        error?: string;
      };
      if (!response.ok || !body.token) {
        throw new Error(body.error ?? "Could not start Live Voice.");
      }
      return body;
    };

    const client = new GeminiLiveClient(tokenProvider, {
      onState: (state) => {
        if (state === "connecting") updateState("connecting");
        else if (state === "reconnecting") updateState("reconnecting");
        else if (state === "listening") updateState("listening");
      },
      onAudio: (pcm) => {
        updateState("speaking");
        audio.enqueue(pcm);
      },
      onInputTranscript: (chunk) => {
        // A barge-in can be transcribed while Gemini is still speaking a
        // BrowserPilot text event. Preserve that response's text→audio origin;
        // flushTranscripts resets the next turn to audio afterward.
        if (turnInputModalityRef.current !== "text") {
          turnInputModalityRef.current = "audio";
        }
        inputTranscriptRef.current = mergeTranscriptChunk(inputTranscriptRef.current, chunk);
        setTranscript(inputTranscriptRef.current);
      },
      onOutputTranscript: (chunk) => {
        outputTranscriptRef.current = mergeTranscriptChunk(outputTranscriptRef.current, chunk);
      },
      onInterrupted: () => {
        audio.clearPlayback();
        flushTranscripts();
        updateState("listening");
      },
      onTurnComplete: () => {
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
        flushTimerRef.current = setTimeout(flushTranscripts, 250);
        updateState("listening");
      },
      onToolCalls: handleToolCalls,
      onError: (message) => {
        telemetry("voice.error", message, "error");
        setError(message);
        updateState("error");
      },
      onDiagnostic: telemetry,
    });
    clientRef.current = client;

    try {
      await client.start();
      if (startAttempt !== startAttemptRef.current) {
        client.close();
        await audio.stop();
        return;
      }
      await audio.start((pcm) => client.sendAudio(pcm));
      if (startAttempt !== startAttemptRef.current) {
        client.close();
        await audio.stop();
        return;
      }
      telemetry("microphone.started");
      updateState("listening");
    } catch (startError) {
      const canceled = startAttempt !== startAttemptRef.current;
      client.close();
      await audio.stop();
      if (clientRef.current === client) clientRef.current = null;
      if (audioRef.current === audio) audioRef.current = null;
      if (!canceled) {
        telemetry("voice.start_failed", (startError as Error).message, "error");
        setError((startError as Error).message);
        updateState("error");
      }
    }
  }, [
    flushTranscripts,
    handleToolCalls,
    runtimeConnected,
    sessionId,
    telemetry,
    updateState,
  ]);

  const handleRuntimeEvent = useCallback((event: RuntimeEvent) => {
    const client = clientRef.current;
    if (!client) return;

    switch (event.type) {
      case "agent_text":
        if (event.text) pendingAgentTextRef.current = event.text;
        break;
      case "tool_activity":
        if (event.summary && Date.now() - lastToolUpdateRef.current > 8_000) {
          lastToolUpdateRef.current = Date.now();
          turnInputModalityRef.current = "text";
          client.sendText(
            `[BROWSERPILOT_EVENT] Browser progress only (not a new user request): ${event.summary}`,
          );
        }
        break;
      case "approval_request":
        turnInputModalityRef.current = "text";
        client.sendText(
          `[BROWSERPILOT_EVENT] Sensitive approval required in the visible UI: ${event.summary ?? "Review the pending action."} Voice approval is forbidden.`,
        );
        break;
      case "choice_request":
        if (event.requestId && event.options) {
          choicesRef.current.set(event.requestId, event.options);
          turnInputModalityRef.current = "text";
          client.sendText(
            `[BROWSERPILOT_EVENT] Non-sensitive choice ${event.requestId}: ${event.question ?? "Choose one"}. Exact options: ${JSON.stringify(
              event.options.map((option) => ({
                optionId: option.value,
                label: option.label,
              })),
            )}`,
          );
        }
        break;
      case "choice_resolved":
        if (event.requestId) choicesRef.current.delete(event.requestId);
        break;
      case "agent_turn_complete":
        turnInputModalityRef.current = "text";
        client.sendText(
          `[BROWSERPILOT_EVENT] Claude browser task ${event.outcome ?? "completed"}. Final report: ${
            pendingAgentTextRef.current || "No additional report was provided."
          }`,
        );
        pendingAgentTextRef.current = "";
        break;
      case "error":
        if (event.message) {
          turnInputModalityRef.current = "text";
          client.sendText(`[BROWSERPILOT_EVENT] Browser error: ${event.message}`);
        }
        break;
      case "session_status":
        if (event.status && ["stopped", "failed", "interrupted"].includes(event.status)) {
          turnInputModalityRef.current = "text";
          client.sendText(`[BROWSERPILOT_EVENT] Browser session is ${event.status}.`);
        }
        break;
    }
  }, []);

  useImperativeHandle(ref, () => ({ handleRuntimeEvent, stop }), [handleRuntimeEvent, stop]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!runtimeConnected && stateRef.current !== "off") stop();
  }, [runtimeConnected, stop]);

  const active = voiceState !== "off" && voiceState !== "error";
  const label =
    voiceState === "connecting"
      ? "Connecting voice…"
      : voiceState === "reconnecting"
        ? "Reconnecting voice…"
        : voiceState === "speaking"
          ? "Gemini speaking"
          : voiceState === "listening"
            ? "Listening"
            : "Start Live Voice";

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Not an icon button. This is a *mode* — you are either talking to the
          robot or you are not — and it sat beside the dictation mic as an
          identical grey square distinguished only by its tooltip. A waveform,
          a word, and the signal colour when live make it a different thing. */}
      <Button
        type="button"
        size="sm"
        variant={active ? "default" : "outline"}
        onClick={() => (active ? stop() : void start())}
        disabled={!runtimeConnected}
        aria-pressed={active}
        aria-label={active ? "Stop talking to the robot" : "Talk to the robot"}
        title={active ? "Stop talking to the robot" : "Talk to the robot — it answers out loud"}
        className={active ? "gap-1.5" : "text-muted-foreground gap-1.5"}
      >
        {active ? <SquareIcon /> : <AudioLinesIcon />}
        Voice
      </Button>
      {active ? (
        <div className="hidden min-w-0 max-w-44 sm:block">
          <p className="text-signal truncate text-xs font-medium">{label}</p>
          {transcript ? (
            <p className="text-muted-foreground truncate text-[11px]">{transcript}</p>
          ) : null}
        </div>
      ) : error ? (
        <p className="text-destructive hidden max-w-52 truncate text-xs sm:block" title={error}>
          {error}
        </p>
      ) : null}
    </div>
  );
});
