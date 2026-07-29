/**
 * The console's palette, carried over so the phone is recognisably the same
 * product. Graphite for everything structural, one amber for the things that
 * want a person — an approval waiting, a sign-in expired — and green only for
 * a browser that is genuinely running.
 */
export const colour = {
  background: "#0f1115",
  card: "#161a21",
  cardRaised: "#1c212a",
  border: "#232935",
  borderStrong: "#2f3644",

  text: "#e7e9ee",
  textMuted: "#98a0b0",
  textFaint: "#6b7280",

  signal: "#e8a33d",
  signalInk: "#0f1115",
  running: "#5fd08a",
  danger: "#f26d6d",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const type = {
  /** Numbers, identifiers and machine output line up when they are monospaced. */
  mono: "ui-monospace",
  title: { fontSize: 20, fontWeight: "600" as const, color: colour.text },
  heading: { fontSize: 16, fontWeight: "600" as const, color: colour.text },
  body: { fontSize: 15, color: colour.text },
  small: { fontSize: 13, color: colour.textMuted },
  tiny: { fontSize: 11, color: colour.textFaint },
} as const;
