import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { isPaired } from "../lib/api";
import { colour } from "../lib/theme";
import { Loading } from "../components/ui";
import { PairingScreen } from "../components/pairing";

/**
 * Everything behind one question: is this phone paired?
 *
 * Pairing is not a screen you can navigate away from, because nothing else
 * works without it, so it is a gate rather than a route. Once through, the
 * tabs are all there is.
 */
export default function RootLayout() {
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    // A stale or unavailable keystore must not strand the app on its loading
    // surface. Treat it like an unpaired device so the person can recover by
    // scanning a fresh code.
    void isPaired().then(setPaired).catch(() => setPaired(false));
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {paired === null ? (
        <Loading />
      ) : paired ? (
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colour.background },
            headerTintColor: colour.text,
            headerTitleStyle: { fontWeight: "600" },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colour.background },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
        </Stack>
      ) : (
        <PairingScreen onPaired={() => setPaired(true)} />
      )}
    </SafeAreaProvider>
  );
}
