import { useCallback, useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, consoleUrl, unpair } from "../../lib/api";
import { colour, space, type } from "../../lib/theme";
import { Button, Card, Heading, Loading, Mono, Notice, Screen } from "../../components/ui";

type Me = { user: { name: string; email: string; role: string } };

/**
 * Who this phone is signed in as, and how to stop being signed in.
 *
 * Unpairing only forgets the credentials on this device. Revoking it properly —
 * so a phone that is no longer in your hands cannot come back — happens in the
 * console, and this says so rather than implying otherwise.
 */
export default function AccountTab() {
  const [me, setMe] = useState<Me["user"] | null>(null);
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBase(await consoleUrl());
    try {
      const data = await api<Me>("/api/device/me");
      setMe(data.user);
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

  const confirmUnpair = () => {
    const go = () => void unpair().then(() => setMe(null));
    if (Platform.OS === "web") {
      go();
      return;
    }
    Alert.alert(
      "Unpair this phone?",
      "It stops reaching your sessions until you scan a new code. To stop a phone you no longer have, revoke it from the console instead.",
      [
        { text: "Keep it", style: "cancel" },
        { text: "Unpair", style: "destructive", onPress: go },
      ],
    );
  };

  if (!me && !error) return <Loading />;

  return (
    <Screen>
      <Heading title="Account" />

      {error ? <Notice text={error} tone="error" /> : null}

      {me ? (
        <Card>
          <Text style={type.heading}>{me.name}</Text>
          <Text style={[type.small, { marginTop: 2 }]}>{me.email}</Text>
          <Text style={[type.tiny, { marginTop: space.sm }]}>
            {me.role === "ADMIN" ? "Administrator" : "User"}
          </Text>
        </Card>
      ) : null}

      <Card>
        <Text style={[type.small, { color: colour.text }]}>Console</Text>
        <Mono style={{ marginTop: 4 }}>{base}</Mono>
      </Card>

      <View style={{ marginTop: space.md }}>
        <Button label="Unpair this phone" variant="danger" onPress={confirmUnpair} />
        <Text style={[type.tiny, { marginTop: space.sm }]}>
          Lost the phone? Revoke it from Devices in the console — that works even when the phone
          does not answer.
        </Text>
      </View>
    </Screen>
  );
}
