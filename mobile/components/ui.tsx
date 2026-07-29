import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type RefreshControlProps,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colour, radius, space, type } from "../lib/theme";

/**
 * The pieces every screen is built from.
 *
 * Kept deliberately small and local rather than pulling in a component
 * library: the console has a specific look, and matching it exactly matters
 * more here than breadth. Everything is sized for a thumb — 44pt minimum on
 * anything tappable — and nothing depends on hover, which a phone has not got.
 */

export function Screen({
  children,
  scroll = true,
  refreshControl,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      refreshControl={refreshControl}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={type.title}>{title}</Text>
      {subtitle ? <Text style={[type.small, { marginTop: 4 }]}>{subtitle}</Text> : null}
    </View>
  );
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed, style]}
    >
      {children}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        pressed && !inactive && { opacity: 0.75 },
        inactive && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === "primary" ? colour.signalInk : colour.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === "primary" && { color: colour.signalInk },
            variant === "danger" && { color: colour.danger },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = "none",
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "characters";
  keyboardType?: "default" | "url";
}) {
  return (
    <View style={{ marginBottom: space.md }}>
      <Text style={[type.small, { marginBottom: 6, color: colour.text }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colour.textFaint}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        style={styles.input}
      />
    </View>
  );
}

/**
 * The state of a browser, in a word and a colour.
 *
 * Amber means it wants a person, which is the one state worth interrupting
 * someone for; green means it is working on its own.
 */
export function StatusLamp({ status, live }: { status: string; live?: boolean }) {
  const { label, tint } = describeStatus(status, live);
  return (
    <View style={styles.statusRow}>
      <View style={[styles.lamp, { backgroundColor: tint }]} />
      <Text style={[type.small, { color: tint }]}>{label}</Text>
    </View>
  );
}

export function describeStatus(status: string, live?: boolean): { label: string; tint: string } {
  if (status === "awaiting_approval") return { label: "needs you", tint: colour.signal };
  if (status === "working") return { label: "working", tint: colour.running };
  if (status === "starting") return { label: "starting", tint: colour.running };
  if (status === "idle") return { label: live ? "ready" : "idle", tint: colour.textMuted };
  if (status === "failed") return { label: "failed", tint: colour.danger };
  if (status === "interrupted") return { label: "interrupted", tint: colour.textFaint };
  return { label: "stopped", tint: colour.textFaint };
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={[type.body, { color: colour.textMuted, textAlign: "center" }]}>{title}</Text>
      {hint ? (
        <Text style={[type.small, { marginTop: 6, textAlign: "center" }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Notice({ text, tone = "info" }: { text: string; tone?: "info" | "error" }) {
  return (
    <View
      style={[
        styles.notice,
        tone === "error" && { borderColor: colour.danger, backgroundColor: "#f26d6d18" },
      ]}
    >
      <Text style={[type.small, tone === "error" && { color: colour.danger }]}>{text}</Text>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colour.signal} />
      {label ? <Text style={[type.small, { marginTop: space.md }]}>{label}</Text> : null}
    </View>
  );
}

export function Mono({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.tiny, { fontFamily: type.mono }, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colour.background },
  screenContent: { padding: space.lg, paddingBottom: space.xxl },
  card: {
    backgroundColor: colour.card,
    borderColor: colour.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.md,
  },
  cardPressed: { backgroundColor: colour.cardRaised, borderColor: colour.borderStrong },
  button: {
    minHeight: 46,
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  buttonPrimary: { backgroundColor: colour.signal },
  buttonSecondary: { backgroundColor: "transparent", borderColor: colour.borderStrong },
  buttonDanger: { backgroundColor: "transparent", borderColor: colour.danger },
  buttonLabel: { fontSize: 15, fontWeight: "600", color: colour.text },
  input: {
    minHeight: 46,
    backgroundColor: colour.background,
    borderColor: colour.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    color: colour.text,
    fontSize: 15,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  lamp: { width: 8, height: 8, borderRadius: 4 },
  empty: {
    paddingVertical: space.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    borderWidth: 1,
    borderColor: colour.border,
    backgroundColor: colour.card,
    borderRadius: radius.sm,
    padding: space.md,
    marginBottom: space.md,
  },
});
