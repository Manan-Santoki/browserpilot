import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  GeminiLiveClient,
  type GeminiFunctionCall,
} from "../lib/gemini-live";
import { MobileLiveAudio } from "../lib/live-audio";
import { getLiveToken, type VoiceTranscriptMessage } from "../lib/api";
import { colour, radius, space, type } from "../lib/theme";

export type VoiceCommandResult = {
  ok: boolean;
  status: "accepted" | "busy" | "idle" | "invalid" | "failed";
  message: string;
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
};

export type MobileLiveVoiceHandle = {
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
  recordTranscript: (message: VoiceTranscriptMessage) => void;
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
  return `gemini_${safe || Date.now()}`;
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

export const MobileLiveVoice = forwardRef<MobileLiveVoiceHandle, Props>(
  function MobileLiveVoice(
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
    const [caption, setCaption] = useState("");
    const [error, setError] = useState("");
    const clientRef = useRef<GeminiLiveClient | null>(null);
    const audioRef = useRef<MobileLiveAudio | null>(null);
    const stateRef = useRef<VoiceState>("off");
    const runtimeConnectedRef = useRef(runtimeConnected);
    const runtimeStatusRef = useRef(runtimeStatus);
    const choicesRef = useRef(
      new Map<string, Array<{ label: string; value: string; description?: string }>>(),
    );
    const lastToolUpdateRef = useRef(0);
    const inputTranscriptRef = useRef("");
    const outputTranscriptRef = useRef("");
    const turnInputModalityRef = useRef<"text" | "audio">("audio");
    const transcriptCounterRef = useRef(0);
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingAgentTextRef = useRef("");
    const startAttemptRef = useRef(0);

    useEffect(() => {
      runtimeConnectedRef.current = runtimeConnected;
      runtimeStatusRef.current = runtimeStatus;
    }, [runtimeConnected, runtimeStatus]);

    const updateState = useCallback((next: VoiceState) => {
      stateRef.current = next;
      setVoiceState(next);
    }, []);

    const telemetry = useCallback(
      (event: string, detail?: string, level: "info" | "warn" | "error" = "info") => {
        const method =
          level === "error" ? console.error : level === "warn" ? console.warn : console.info;
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
        const message: VoiceTranscriptMessage = {
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
      setCaption("");
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
      setCaption("");
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
                      message: "That choice is stale or invalid.",
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
          responses.push({ id: call.id, name: call.name, response: { output } });
        }
        return responses;
      },
      [interruptBrowserTask, startBrowserTask, submitChoice, telemetry],
    );

    const start = useCallback(async () => {
      if (!runtimeConnected) {
        setError("Reconnect the browser session first.");
        updateState("error");
        return;
      }
      if (stateRef.current !== "off" && stateRef.current !== "error") return;

      setError("");
      updateState("connecting");
      telemetry("voice.start");
      const startAttempt = ++startAttemptRef.current;
      const audio = new MobileLiveAudio();
      audioRef.current = audio;
      const client = new GeminiLiveClient(() => getLiveToken(sessionId), {
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
          // Preserve text→audio attribution when the user barges in while a
          // BrowserPilot event is still being spoken.
          if (turnInputModalityRef.current !== "text") {
            turnInputModalityRef.current = "audio";
          }
          inputTranscriptRef.current = mergeTranscriptChunk(inputTranscriptRef.current, chunk);
          setCaption(inputTranscriptRef.current);
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
              `[BROWSERPILOT_EVENT] Choice ${event.requestId}: ${event.question ?? "Choose one"}. Exact options: ${JSON.stringify(
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

    useImperativeHandle(ref, () => ({ handleRuntimeEvent, stop }), [
      handleRuntimeEvent,
      stop,
    ]);

    useEffect(() => {
      const subscription = AppState.addEventListener("change", (next) => {
        if (next !== "active") stop();
      });
      return () => {
        subscription.remove();
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
              ? caption || "Listening"
              : error || "Start Live Voice";

    return (
      <View style={styles.container}>
        {active || error ? (
          <View style={styles.label}>
            <Text numberOfLines={1} style={[type.tiny, error ? { color: colour.danger } : null]}>
              {label}
            </Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={active ? "Stop Live Voice" : "Start Live Voice"}
          disabled={!runtimeConnected}
          onPress={() => (active ? stop() : void start())}
          style={[
            styles.button,
            active && styles.buttonActive,
            !runtimeConnected && { opacity: 0.45 },
          ]}
        >
          <Ionicons
            name={active ? "mic-off-outline" : "mic-outline"}
            size={20}
            color={active ? colour.signalInk : error ? colour.danger : colour.text}
          />
        </Pressable>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    position: "relative",
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colour.borderStrong,
    backgroundColor: colour.card,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonActive: {
    borderColor: colour.signal,
    backgroundColor: colour.signal,
  },
  label: {
    position: "absolute",
    bottom: 50,
    left: 0,
    maxWidth: 220,
    minWidth: 100,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colour.border,
    backgroundColor: colour.cardRaised,
    zIndex: 10,
  },
});
