import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { consoleUrl, getFiles, sessionToken, type FileGroup } from "../../lib/api";
import { colour, space, type } from "../../lib/theme";
import { Card, Empty, Heading, Loading, Mono, Notice, Screen } from "../../components/ui";

/**
 * Everything the robot has downloaded, under the session that fetched it.
 *
 * Opening one hands it to the phone's own viewer rather than rendering it
 * here: a phone already knows how to show a PDF better than this app would.
 *
 * The file is fetched with the session token in a header and written to the
 * app's own storage first. Handing the viewer a URL instead would mean putting
 * the token in it — where it would sit in logs and history — because an
 * external viewer cannot carry a header.
 */
export default function FilesTab() {
  const [groups, setGroups] = useState<FileGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { groups } = await getFiles();
      setGroups(groups);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const [opening, setOpening] = useState<string | null>(null);

  const open = async (url: string, filename: string) => {
    if (opening) return;
    setOpening(filename);
    setError(null);
    try {
      const [base, token] = await Promise.all([consoleUrl(), sessionToken()]);
      const target = `${FileSystem.cacheDirectory}${encodeURIComponent(filename)}`;

      const result = await FileSystem.downloadAsync(`${base}${url}?download=1`, target, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (result.status !== 200) throw new Error("That file could not be fetched.");

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(result.uri);
      } else {
        setError("This device has nothing that can open that file.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(null);
    }
  };

  if (!groups && !error) return <Loading label="Fetching files…" />;

  const total = groups?.reduce((sum, g) => sum + g.files.length, 0) ?? 0;

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colour.textMuted} />}>
      <Heading
        title="Files"
        subtitle={total === 0 ? "Nothing downloaded yet." : `${total} file${total === 1 ? "" : "s"}`}
      />

      {error ? <Notice text={error} tone="error" /> : null}

      {groups?.map((group) => (
        <Card key={group.sessionId} style={{ padding: 0, overflow: "hidden" }}>
          <View style={{ padding: space.md, borderBottomWidth: 1, borderBottomColor: colour.border }}>
            <Text style={type.body} numberOfLines={1}>
              {group.title}
            </Text>
            <Mono style={{ marginTop: 2 }}>
              {group.siteName ? `${group.siteName} · ` : ""}
              {new Date(group.startedAt).toLocaleDateString()}
            </Mono>
          </View>

          {group.files.map((file) => (
            <Text
              key={file.filename}
              onPress={() => void open(file.url, file.filename)}
              style={{
                paddingHorizontal: space.md,
                paddingVertical: space.md,
                color: colour.text,
                fontSize: 14,
                fontFamily: type.mono,
              }}
              numberOfLines={1}
            >
              <Ionicons
                name={opening === file.filename ? "hourglass-outline" : "download-outline"}
                size={14}
                color={colour.textMuted}
              />
              {"  "}
              {file.filename}
            </Text>
          ))}
        </Card>
      ))}

      {groups?.length === 0 ? (
        <Empty title="No downloads yet." hint="Ask the robot to fetch a document and it appears here." />
      ) : null}
    </Screen>
  );
}
