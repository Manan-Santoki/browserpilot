export type PairingCode = {
  code: string;
  consoleUrl?: string;
};

/**
 * A typed code is just the short token. A scanned code is the versioned JSON
 * envelope emitted by the console, which also tells the app where to redeem
 * it. Keeping this parser independent of React Native makes the QR contract
 * straightforward to test.
 */
export function parsePairingCode(value: string): PairingCode {
  const input = value.trim();

  if (!input.startsWith("{")) {
    return { code: input.toUpperCase() };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new Error("That QR code is not a BrowserPilot pairing code.");
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("v" in payload) ||
    payload.v !== 1 ||
    !("code" in payload) ||
    typeof payload.code !== "string" ||
    !("url" in payload) ||
    typeof payload.url !== "string"
  ) {
    throw new Error("That QR code is not a BrowserPilot pairing code.");
  }

  const code = payload.code.trim().toUpperCase();
  if (!code) {
    throw new Error("That QR code does not contain a pairing code.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(payload.url);
  } catch {
    throw new Error("That QR code contains an invalid console address.");
  }

  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !endpoint.pathname.endsWith("/api/pair")
  ) {
    throw new Error("That QR code contains an invalid console address.");
  }

  endpoint.pathname = endpoint.pathname.slice(0, -"/api/pair".length) || "/";
  endpoint.search = "";
  endpoint.hash = "";

  return {
    code,
    consoleUrl: endpoint.toString().replace(/\/$/, ""),
  };
}
