import { describe, expect, test } from "bun:test";
import { parsePairingCode } from "./pairing-code";

describe("parsePairingCode", () => {
  test("normalises a manually entered code", () => {
    expect(parsePairingCode("  abcd2345 ")).toEqual({ code: "ABCD2345" });
  });

  test("reads the code and console from a scanned payload", () => {
    expect(
      parsePairingCode(
        JSON.stringify({
          v: 1,
          code: "abcd2345",
          url: "http://localhost:3000/api/pair",
        }),
      ),
    ).toEqual({
      code: "ABCD2345",
      consoleUrl: "http://localhost:3000",
    });
  });

  test("preserves a console base path", () => {
    expect(
      parsePairingCode(
        JSON.stringify({
          v: 1,
          code: "ABCD2345",
          url: "https://example.com/browserpilot/api/pair",
        }),
      ),
    ).toEqual({
      code: "ABCD2345",
      consoleUrl: "https://example.com/browserpilot",
    });
  });

  test("rejects a QR payload from another application", () => {
    expect(() => parsePairingCode(JSON.stringify({ url: "https://example.com" }))).toThrow(
      "not a BrowserPilot pairing code",
    );
  });
});
