import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_CONSOLE_URL, consoleUrl, pair, setConsoleUrl } from "../lib/api";
import { colour, radius, space, type } from "../lib/theme";
import { Button, Field, Loading, Notice } from "./ui";

/**
 * Linking this phone to an account.
 *
 * The console shows a QR code; scanning it is the whole ceremony. The code is
 * short-lived and single-use, so the camera is the fast path and typing it is
 * the fallback for a phone whose camera is refused — not a lesser option.
 */
export function PairingScreen({ onPaired }: { onPaired: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState(Platform.OS === "web");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const deviceName = Device.deviceName ?? `${Platform.OS} phone`;

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (url.trim()) await setConsoleUrl(url.trim());
      await pair(value.trim().toUpperCase(), deviceName);
      onPaired();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colour.background }}>
      <View style={{ flex: 1, padding: space.lg }}>
        <Text style={[type.title, { marginTop: space.xl }]}>Pair this phone</Text>
        <Text style={[type.small, { marginTop: 6, marginBottom: space.xl }]}>
          Open BrowserPilot on a computer, go to Devices, and show the pairing code.
        </Text>

        {error ? <Notice text={error} tone="error" /> : null}

        {!manual ? (
          <View style={{ flex: 1 }}>
            {!permission ? (
              <Loading />
            ) : !permission.granted ? (
              <View style={{ gap: space.md }}>
                <Notice text="The camera is how the code gets scanned. You can type it instead." />
                <Button label="Allow the camera" onPress={() => void requestPermission()} />
              </View>
            ) : (
              <View style={styles.viewfinder}>
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={busy ? undefined : ({ data }) => void submit(data)}
                />
              </View>
            )}

            <Button
              label="Type the code instead"
              variant="secondary"
              onPress={() => setManual(true)}
              style={{ marginTop: space.lg }}
            />
          </View>
        ) : (
          <View>
            <Field
              label="Pairing code"
              value={code}
              onChangeText={setCode}
              placeholder="7 characters"
              autoCapitalize="characters"
            />
            <Button
              label={busy ? "Pairing…" : "Pair"}
              busy={busy}
              onPress={() => void submit(code)}
            />
            {Platform.OS !== "web" ? (
              <Button
                label="Scan instead"
                variant="secondary"
                onPress={() => setManual(false)}
                style={{ marginTop: space.md }}
              />
            ) : null}
          </View>
        )}

        <View style={{ marginTop: "auto" }}>
          {showUrl ? (
            <Field
              label="Console address"
              value={url}
              onChangeText={setUrl}
              placeholder={DEFAULT_CONSOLE_URL}
              keyboardType="url"
            />
          ) : (
            <Button
              label="Connecting to a different console?"
              variant="secondary"
              onPress={() => {
                void consoleUrl().then(setUrl);
                setShowUrl(true);
              }}
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = {
  viewfinder: {
    flex: 1,
    borderRadius: radius.lg,
    overflow: "hidden" as const,
    borderWidth: 1,
    borderColor: colour.borderStrong,
  },
};
