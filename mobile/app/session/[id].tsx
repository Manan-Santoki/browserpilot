import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getSessionStatus,
  getTicket,
  getTranscript,
  logVoiceTelemetry as postVoiceTelemetry,
  resumeSession,
  saveVoiceTranscript,
  stopSession,
  type VoiceTranscriptMessage,
} from "../../lib/api";
import { colour, radius, space, type } from "../../lib/theme";
import { Button, Mono, Notice, StatusLamp } from "../../components/ui";
import { AgentMarkdown } from "../../components/agent-markdown";
import {
  MobileLiveVoice,
  type MobileLiveVoiceHandle,
  type VoiceCommandResult,
} from "../../components/live-voice";
import {
  LivePreview,
  type LivePreviewHandle,
} from "../../components/live-preview";

type Item =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | {
      kind: "voice_user";
      text: string;
      inputModality: "text" | "audio";
      outputModality: "text" | "audio";
    }
  | {
      kind: "voice_assistant";
      text: string;
      inputModality: "text" | "audio";
      outputModality: "text" | "audio";
    }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "file"; filename: string }
  | { kind: "screenshot"; filename: string; url: string }
  | { kind: "approval"; requestId: string; summary: string; resolved?: string }
  | {
      kind: "choice";
      requestId: string;
      question: string;
      options: Array<{ label: string; value: string; description?: string }>;
      resolved?: { label: string; value: string };
    };

/**
 * One running browser: what it looks like, what it is saying, and the one
 * question it might be waiting on.
 *
 * The screen is the reason the phone exists — the robot asks before anything
 * destructive, and answering that from wherever you are is the whole point.
 * So the approval is not a row in the transcript, it is a bar across the
 * bottom that cannot be scrolled past.
 */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("connecting");
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [continuationId, setContinuationId] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  /**
   * A phone has no room to show a browser and a conversation at once and do
   * either well. Tapping the browser gives it the whole screen — which is what
   * you want when checking what the robot is actually looking at — and tapping
   * again gives the conversation back.
   */
  const [expanded, setExpanded] = useState(false);
  const [previewMinimized, setPreviewMinimized] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const logRef = useRef<ScrollView | null>(null);
  const previewRef = useRef<LivePreviewHandle | null>(null);
  const liveVoiceRef = useRef<MobileLiveVoiceHandle | null>(null);
  // Input and output transcripts may complete together. Serialize their API
  // writes so the server-side event sequence preserves conversation order.
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

  const append = useCallback((item: Item) => setItems((prev) => [...prev, item]), []);

  useEffect(() => {
    navigation.setOptions({ title: "Session" });
  }, [navigation]);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (event) => {
      setExpanded(false);
      setKeyboardOpen(true);
      setKeyboardInset(Platform.OS === "android" ? event.endCoordinates.height : 0);
    });
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardOpen(false);
      setKeyboardInset(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    setEnded(false);
    setContinuationId(null);
    setConnected(false);
    setItems([]);
    setError(null);

    async function connect() {
      try {
        const [details, transcript] = await Promise.all([
          getSessionStatus(String(id)),
          getTranscript<Item>(String(id)),
        ]);
        if (closed) return;
        setItems(transcript.items);
        setStatus(details.status);
        setContinuationId(details.continuationId);
        if (["stopped", "failed", "interrupted"].includes(details.status)) {
          setEnded(true);
          return;
        }

        const { url } = await getTicket(String(id));
        if (closed) return;

        // Declared here rather than in a message: the runtime replays the last
        // frame as the socket opens, and a request sent afterwards would arrive
        // too late for it.
        socket = new WebSocket(`${url}&frames=base64`);
        socketRef.current = socket;

        socket.onopen = () => {
          setConnected(true);
          socket?.send(JSON.stringify({ type: "preview", enabled: true }));
        };
        socket.onclose = () => {
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
        };
        socket.onerror = () => setConnected(false);

        socket.onmessage = (event) => {
          // Everything arrives as text, frames included, by the request above.
          if (typeof event.data !== "string") return;

          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          liveVoiceRef.current?.handleRuntimeEvent(msg);
          switch (msg.type) {
            case "frame":
              previewRef.current?.push(String(msg.data));
              break;
            case "user_msg":
              append({ kind: "you", text: String(msg.text) });
              break;
            case "agent_text":
              append({ kind: "agent", text: String(msg.text) });
              break;
            case "tool_activity":
              append({ kind: "tool", text: String(msg.summary) });
              break;
            case "error":
              append({ kind: "error", text: String(msg.message) });
              break;
            case "file_ready":
              append({ kind: "file", filename: String(msg.filename) });
              break;
            case "approval_request":
              append({
                kind: "approval",
                requestId: String(msg.requestId),
                summary: String(msg.summary),
              });
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
                requestId: String(msg.requestId),
                question: String(msg.question),
                options: Array.isArray(msg.options)
                  ? (msg.options as Array<{
                      label: string;
                      value: string;
                      description?: string;
                    }>)
                  : [],
              });
              break;
            case "choice_resolved":
              setItems((prev) =>
                prev.map((item) =>
                  item.kind === "choice" && item.requestId === msg.requestId
                    ? {
                        ...item,
                        resolved: {
                          label: String(msg.label),
                          value: String(msg.value),
                        },
                      }
                    : item,
                ),
              );
              break;
            case "session_status":
              setStatus(String(msg.status));
              if (["stopped", "failed", "interrupted"].includes(String(msg.status))) {
                setEnded(true);
              }
              break;
            case "voice_command_result": {
              const requestId = String(msg.requestId);
              const waiter = voiceWaitersRef.current.get(requestId);
              if (waiter) {
                clearTimeout(waiter.timer);
                voiceWaitersRef.current.delete(requestId);
                waiter.resolve({
                  ok: Boolean(msg.ok),
                  status: String(msg.status) as VoiceCommandResult["status"],
                  message: String(msg.message),
                });
              }
              break;
            }
          }
        };
      } catch (e) {
        setError((e as Error).message);
      }
    }

    void connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [id, append]);

  const send = () => {
    const text = draft.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.send(JSON.stringify({ type: "user_msg", text }));
    append({ kind: "you", text });
    setDraft("");
  };

  const respond = (requestId: string, approved: boolean) => {
    socketRef.current?.send(JSON.stringify({ type: "approval", requestId, approved }));
  };

  const choose = (requestId: string, value: string) => {
    socketRef.current?.send(JSON.stringify({ type: "choice", requestId, value }));
  };

  const sendVoiceCommand = useCallback(
    (
      command:
        | { type: "voice_task_start"; requestId: string; text: string }
        | { type: "agent_interrupt"; requestId: string },
    ): Promise<VoiceCommandResult> =>
      new Promise((resolve) => {
        const socket = socketRef.current;
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
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "choice", requestId, value: optionId }));
    return true;
  }, []);

  const recordVoiceTranscript = useCallback(
    (message: VoiceTranscriptMessage) => {
      append({
        kind: message.speaker === "assistant" ? "voice_assistant" : "voice_user",
        text: message.text,
        inputModality: message.inputModality,
        outputModality: message.outputModality,
      });
      voiceTranscriptWriteRef.current = voiceTranscriptWriteRef.current
        .catch(() => {
          // A failed message must not block later transcript writes.
        })
        .then(async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await saveVoiceTranscript(String(id), message);
              return;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
            }
          }
          console.error("[live_voice] transcript.save_failed", message.messageId);
        });
    },
    [append, id],
  );

  const logVoiceTelemetry = useCallback(
    (event: string, detail?: string, level: "info" | "warn" | "error" = "info") => {
      void postVoiceTelemetry(String(id), event, detail, level).catch(() => {});
    },
    [id],
  );

  const resume = async () => {
    if (continuationId) {
      router.replace(`/session/${continuationId}`);
      return;
    }

    setResuming(true);
    setError(null);
    try {
      const next = await resumeSession(String(id));
      router.replace(`/session/${next.id}`);
    } catch (e) {
      setError((e as Error).message);
      setResuming(false);
    }
  };

  const pending = items.find((i) => i.kind === "approval" && !i.resolved) as
    | Extract<Item, { kind: "approval" }>
    | undefined;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colour.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <View
        style={{
          flex: 1,
          paddingBottom: keyboardInset,
          flexDirection:
            landscape && !previewMinimized && !keyboardOpen ? "row" : "column",
        }}
      >
        {/* The browser. On a tablet held sideways it takes the left half; on a
            phone it is a band across the top, sized to the frame's own shape,
            unless it has been given the whole screen. */}
        <View
          style={[
            styles.preview,
            (previewMinimized || keyboardOpen) && styles.previewMinimized,
            landscape || expanded ? { flex: 1 } : { aspectRatio: 16 / 10 },
          ]}
        >
          <LivePreview
            ref={previewRef}
            placeholder={
              <Text style={type.small}>
                {connected ? "Waiting for the browser…" : "Connecting…"}
              </Text>
            }
          />

          <View style={styles.previewControls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Minimize live preview"
              hitSlop={8}
              onPress={() => {
                setExpanded(false);
                setPreviewMinimized(true);
              }}
              style={styles.previewControl}
            >
              <Ionicons name="remove-outline" size={18} color={colour.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={expanded ? "Contract live preview" : "Expand live preview"}
              hitSlop={8}
              onPress={() => setExpanded((open) => !open)}
              style={styles.previewControl}
            >
              <Ionicons
                name={expanded ? "contract-outline" : "expand-outline"}
                size={18}
                color={colour.text}
              />
            </Pressable>
          </View>
        </View>

        {previewMinimized && !keyboardOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Restore live preview"
            onPress={() => setPreviewMinimized(false)}
            style={styles.previewCollapsed}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Ionicons name="videocam-outline" size={17} color={colour.textFaint} />
              <Text style={type.small}>Live preview minimized</Text>
            </View>
            <Ionicons name="chevron-down-outline" size={18} color={colour.text} />
          </Pressable>
        ) : null}

        {/* Giving the browser the screen hides the conversation, but never an
            approval waiting for an answer — that is the one thing worth
            interrupting a look at the page for. */}
        <View
          style={[
            { flex: 1 },
            expanded && !landscape && !pending && { display: "none" },
          ]}
        >
          <View style={styles.statusBar}>
            <StatusLamp status={connected ? status : "interrupted"} live={connected} />
            {!ended ? (
              <Pressable onPress={() => void stopSession(String(id)).then(() => setEnded(true))}>
                <Text style={[type.small, { color: colour.danger }]}>Stop</Text>
              </Pressable>
            ) : null}
          </View>

          {error ? <Notice text={error} tone="error" /> : null}

          <ScrollView
            ref={logRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: space.md, gap: space.sm }}
            onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: true })}
          >
            {items.length === 0 ? (
              <Text style={type.small}>
                Tell the robot what to do. It asks before anything destructive.
              </Text>
            ) : null}

            {items.map((item, i) => (
              <Line key={i} item={item} choose={choose} connected={connected} />
            ))}
          </ScrollView>

          {/* An approval is why you opened this. It sits above the composer so
              it cannot be scrolled away from. */}
          {pending ? (
            <View style={styles.approval}>
              <Text style={[type.small, { color: colour.text }]}>{pending.summary}</Text>
              <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                <Button
                  label="Allow"
                  onPress={() => respond(pending.requestId, true)}
                  style={{ flex: 1 }}
                />
                <Button
                  label="Deny"
                  variant="danger"
                  onPress={() => respond(pending.requestId, false)}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : null}

          {!ended ? (
            <View style={[styles.composer, { paddingBottom: Math.max(space.md, insets.bottom) }]}>
              <MobileLiveVoice
                ref={liveVoiceRef}
                sessionId={String(id)}
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
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder={connected ? "Tell the robot what to do…" : "Not connected"}
                placeholderTextColor={colour.textFaint}
                editable={connected}
                style={styles.input}
                onSubmitEditing={send}
                returnKeyType="send"
              />
              <Pressable
                onPress={send}
                disabled={!connected || !draft.trim()}
                style={[styles.sendButton, (!connected || !draft.trim()) && { opacity: 0.4 }]}
              >
                <Ionicons name="send" size={18} color={colour.signalInk} />
              </Pressable>
            </View>
          ) : (
            <View
              style={[
                styles.endedComposer,
                { paddingBottom: Math.max(space.md, insets.bottom) },
              ]}
            >
              <Text style={type.small}>This session has ended.</Text>
              <Button
                label={continuationId ? "Open continuation" : "Resume session"}
                busy={resuming}
                onPress={() => void resume()}
                style={{ alignSelf: "stretch" }}
              />
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Line({
  item,
  choose,
  connected,
}: {
  item: Item;
  choose: (requestId: string, value: string) => void;
  connected: boolean;
}) {
  if (item.kind === "you") {
    return (
      <View style={styles.youBubble}>
        <Text style={[type.body, { color: colour.text }]}>{item.text}</Text>
      </View>
    );
  }
  if (item.kind === "agent") {
    return <AgentMarkdown>{item.text}</AgentMarkdown>;
  }
  if (item.kind === "voice_user") {
    return (
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[type.tiny, { color: colour.textFaint, marginBottom: 3 }]}>
          Voice · {item.inputModality} → {item.outputModality}
        </Text>
        <View style={styles.youBubble}>
          <Text style={[type.body, { color: colour.text }]}>{item.text}</Text>
        </View>
      </View>
    );
  }
  if (item.kind === "voice_assistant") {
    return (
      <View style={styles.voiceAssistant}>
        <Text style={[type.tiny, { color: colour.signal, marginBottom: space.xs }]}>
          Gemini Live · {item.inputModality} → {item.outputModality}
        </Text>
        <AgentMarkdown>{item.text}</AgentMarkdown>
      </View>
    );
  }
  if (item.kind === "tool") {
    return <Mono style={{ color: colour.textFaint }}>{item.text}</Mono>;
  }
  if (item.kind === "error") {
    return <Text style={[type.small, { color: colour.danger }]}>{item.text}</Text>;
  }
  if (item.kind === "file") {
    return <Mono style={{ color: colour.signal }}>↓ {item.filename}</Mono>;
  }
  if (item.kind === "screenshot") {
    return <Mono style={{ color: colour.textFaint }}>Screenshot · {item.filename}</Mono>;
  }
  if (item.kind === "choice") {
    return (
      <View style={styles.choice}>
        <Text style={[type.tiny, { color: colour.signal, textTransform: "uppercase" }]}>
          Choose one
        </Text>
        <Text style={[type.small, { color: colour.text, marginTop: space.xs }]}>
          {item.question}
        </Text>
        <View style={{ gap: space.sm, marginTop: space.md }}>
          {item.options.map((option) => (
            <Button
              key={option.value}
              label={option.label}
              variant="secondary"
              disabled={Boolean(item.resolved) || !connected}
              onPress={() => choose(item.requestId, option.value)}
            />
          ))}
        </View>
        {item.resolved ? (
          <Text style={[type.tiny, { marginTop: space.sm }]}>
            Selected: {item.resolved.label}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <Mono style={{ color: colour.signal }}>
      {item.summary} — {item.resolved ?? "waiting"}
    </Mono>
  );
}

const styles = StyleSheet.create({
  voiceAssistant: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: colour.card,
    padding: space.sm,
  },
  preview: {
    backgroundColor: "#000",
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  previewMinimized: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
  previewCollapsed: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
    backgroundColor: colour.card,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  previewControls: {
    position: "absolute",
    right: space.sm,
    bottom: space.sm,
    flexDirection: "row",
    gap: 2,
    borderRadius: radius.sm,
    backgroundColor: "#0f1115bb",
  },
  previewControl: {
    padding: space.sm,
  },
  approval: {
    borderTopWidth: 1,
    borderTopColor: colour.signal,
    backgroundColor: "#e8a33d14",
    padding: space.md,
  },
  choice: {
    borderWidth: 1,
    borderColor: colour.signal,
    backgroundColor: "#e8a33d14",
    borderRadius: radius.md,
    padding: space.md,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colour.border,
  },
  endedComposer: {
    gap: space.sm,
    padding: space.md,
    borderTopWidth: 1,
    borderTopColor: colour.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    backgroundColor: colour.card,
    borderColor: colour.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    color: colour.text,
    fontSize: 15,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colour.signal,
    alignItems: "center",
    justifyContent: "center",
  },
  youBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colour.cardRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
});
