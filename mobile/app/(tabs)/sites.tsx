import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { getSites, startSession, type Site } from "../../lib/api";
import { colour, space, type } from "../../lib/theme";
import { Button, Card, Empty, Heading, Loading, Mono, Notice, Screen } from "../../components/ui";

/**
 * Where the robot can be sent, and starting it off.
 *
 * A site needing a sign-in cannot be linked from here — that has to happen at a
 * real keyboard, in a browser you can see — so the card says so plainly rather
 * than offering a button that leads nowhere.
 */
export default function SitesTab() {
  const router = useRouter();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { sites } = await getSites();
      setSites(sites);
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

  const start = async (site: Site) => {
    setStarting(site.id);
    setError(null);
    try {
      const { id } = await startSession(site.id);
      router.push(`/session/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  if (!sites && !error) return <Loading label="Loading sites…" />;

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colour.textMuted} />}>
      <Heading title="Sites" subtitle="Applications the robot can drive for you." />

      {error ? <Notice text={error} tone="error" /> : null}

      {sites?.map((site) => (
        <Card key={site.id}>
          <Text style={type.heading}>{site.name}</Text>
          <Mono style={{ marginTop: 2 }}>{site.baseUrl}</Mono>

          <View style={{ marginTop: space.md }}>
            {site.ready ? (
              <Button
                label={starting === site.id ? "Starting…" : "Start a session"}
                busy={starting === site.id}
                onPress={() => void start(site)}
              />
            ) : (
              <Text style={[type.small, { color: colour.signal }]}>
                {site.loginStrategy === "persistent_profile"
                  ? site.linkState === "expired"
                    ? "Your sign-in has expired. Sign in again from a computer to use this."
                    : "Sign in to this site from a computer once, then it works here."
                  : "No account set up for you on this site yet."}
              </Text>
            )}
          </View>
        </Card>
      ))}

      {sites?.length === 0 ? (
        <Empty title="No sites registered." hint="An administrator adds these from the console." />
      ) : null}
    </Screen>
  );
}
