import { useCallback, useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { getTicket, stopSession } from "../../lib/api";
import { colour, radius, space, type } from "../../lib/theme";
import { Button, Mono, Notice, StatusLamp } from "../../components/ui";

type Item =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string }
  | { kind: "file"; filename: string }
  | { kind: "approval"; requestId: string; summary: string; resolved?: string };

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
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("connecting");
  const [connected, setConnected] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const logRef = useRef<ScrollView | null>(null);

  const append = useCallback((item: Item) => setItems((prev) => [...prev, item]), []);

  useEffect(() => {
    navigation.setOptions({ title: "Session" });
  }, [navigation]);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;

    async function connect() {
      try {
        const { url } = await getTicket(String(id));
        if (closed) return;

        socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          setConnected(true);
          // Binary frames are awkward to turn into something an <Image> will
          // take here, and the runtime already holds them as base64, so ask
          // for text before asking for frames at all.
          socket?.send(JSON.stringify({ type: "frame_encoding", encoding: "base64" }));
          socket?.send(JSON.stringify({ type: "preview", enabled: true }));
        };
        socket.onclose = () => setConnected(false);
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

          switch (msg.type) {
            case "frame":
              setFrame(String(msg.data));
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
            case "session_status":
              setStatus(String(msg.status));
              if (["stopped", "failed", "interrupted"].includes(String(msg.status))) {
                setEnded(true);
              }
              break;
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

  const pending = items.find((i) => i.kind === "approval" && !i.resolved) as
    | Extract<Item, { kind: "approval" }>
    | undefined;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colour.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={{ flex: 1, flexDirection: landscape ? "row" : "column" }}>
        {/* The browser. On a tablet held sideways it takes the left half; on a
            phone it is a band across the top, sized to the frame's own shape. */}
        <View style={[styles.preview, landscape ? { flex: 1 } : { aspectRatio: 16 / 10 }]}>
          {frame ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${frame}` }}
              style={{ flex: 1 }}
              resizeMode="contain"
            />
          ) : (
            <View style={styles.previewEmpty}>
              <Text style={type.small}>
                {connected ? "Waiting for the browser…" : "Connecting…"}
              </Text>
            </View>
          )}
        </View>

        <View style={{ flex: 1 }}>
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
              <Line key={i} item={item} />
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
            <View style={styles.composer}>
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
            <View style={styles.composer}>
              <Text style={type.small}>This session has ended.</Text>
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Line({ item }: { item: Item }) {
  if (item.kind === "you") {
    return (
      <View style={styles.youBubble}>
        <Text style={[type.body, { color: colour.text }]}>{item.text}</Text>
      </View>
    );
  }
  if (item.kind === "agent") {
    return <Text style={type.body}>{item.text}</Text>;
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
  return (
    <Mono style={{ color: colour.signal }}>
      {item.summary} — {item.resolved ?? "waiting"}
    </Mono>
  );
}

const styles = StyleSheet.create({
  preview: {
    backgroundColor: "#000",
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  previewEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colour.border,
  },
  approval: {
    borderTopWidth: 1,
    borderTopColor: colour.signal,
    backgroundColor: "#e8a33d14",
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
