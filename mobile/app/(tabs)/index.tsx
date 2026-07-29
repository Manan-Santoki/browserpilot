import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { getSessions, type RobotSession } from "../../lib/api";
import { colour, space, type } from "../../lib/theme";
import { Card, Empty, Heading, Loading, Mono, Notice, Screen, StatusLamp } from "../../components/ui";

/**
 * What the robot is doing, and what it has done.
 *
 * Anything wanting a person comes first — that is the only reason to open this
 * on a phone rather than at a desk — then whatever is running, then history.
 */
export default function SessionsTab() {
  const router = useRouter();
  const [sessions, setSessions] = useState<RobotSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { sessions } = await getSessions();
      setSessions(sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Reloads whenever the tab comes forward: a session started at a desk should
  // be here by the time you look, without pulling to refresh.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!sessions && !error) return <Loading label="Looking for sessions…" />;

  const waiting = sessions?.filter((s) => s.status === "awaiting_approval") ?? [];
  const live = sessions?.filter((s) => s.live && s.status !== "awaiting_approval") ?? [];
  const past = sessions?.filter((s) => !s.live && s.status !== "awaiting_approval") ?? [];

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colour.textMuted} />}>
      <Heading
        title="Sessions"
        subtitle={
          waiting.length > 0
            ? `${waiting.length} waiting for you`
            : live.length > 0
              ? `${live.length} running`
              : "Nothing running"
        }
      />

      {error ? <Notice text={error} tone="error" /> : null}

      {waiting.map((session) => (
        <SessionCard key={session.id} session={session} onPress={() => router.push(`/session/${session.id}`)} highlight />
      ))}
      {live.map((session) => (
        <SessionCard key={session.id} session={session} onPress={() => router.push(`/session/${session.id}`)} />
      ))}

      {past.length > 0 ? (
        <Text style={[type.tiny, { marginTop: space.lg, marginBottom: space.sm, letterSpacing: 1 }]}>
          EARLIER
        </Text>
      ) : null}
      {past.map((session) => (
        <SessionCard key={session.id} session={session} onPress={() => router.push(`/session/${session.id}`)} />
      ))}

      {sessions?.length === 0 ? (
        <Empty title="No sessions yet." hint="Start one from the Sites tab." />
      ) : null}
    </Screen>
  );
}

function SessionCard({
  session,
  onPress,
  highlight,
}: {
  session: RobotSession;
  onPress: () => void;
  highlight?: boolean;
}) {
  return (
    <Card onPress={onPress} style={highlight ? { borderColor: colour.signal } : undefined}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <StatusLamp status={session.status} live={session.live} />
        <Mono>{new Date(session.startedAt).toLocaleDateString()}</Mono>
      </View>
      <Text style={[type.heading, { marginTop: space.sm }]} numberOfLines={1}>
        {session.title ?? session.siteName ?? "Session"}
      </Text>
      {session.siteName ? <Mono style={{ marginTop: 2 }}>{session.siteName}</Mono> : null}
    </Card>
  );
}
