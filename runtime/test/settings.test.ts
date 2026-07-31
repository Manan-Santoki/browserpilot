import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, parseSettings } from "../src/settings";

describe("parseSettings", () => {
  test("returns defaults when the table is empty", () => {
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  test("defaults are sane for a modest host", () => {
    // Each browser costs 200-400 MB, so these must stay conservative until an
    // operator raises them deliberately.
    expect(DEFAULT_SETTINGS.perUserSessionLimit).toBe(3);
    expect(DEFAULT_SETTINGS.globalSessionLimit).toBe(8);
    expect(DEFAULT_SETTINGS.idleTimeoutMs).toBe(600_000);
    expect(DEFAULT_SETTINGS.hardCapMs).toBe(3_600_000);
  });

  test("stored rows override the defaults", () => {
    const parsed = parseSettings([
      { key: "perUserSessionLimit", value: 5 },
      { key: "idleTimeoutMs", value: 120_000 },
    ]);
    expect(parsed.perUserSessionLimit).toBe(5);
    expect(parsed.idleTimeoutMs).toBe(120_000);
    // Untouched keys keep their default.
    expect(parsed.globalSessionLimit).toBe(DEFAULT_SETTINGS.globalSessionLimit);
  });

  test("unknown keys are ignored rather than crashing the runtime", () => {
    expect(parseSettings([{ key: "somethingRemoved", value: 1 }])).toEqual(DEFAULT_SETTINGS);
  });

  test("a value of the wrong type falls back to the default", () => {
    const parsed = parseSettings([
      { key: "perUserSessionLimit", value: "not a number" },
      { key: "globalSessionLimit", value: null },
    ]);
    expect(parsed.perUserSessionLimit).toBe(DEFAULT_SETTINGS.perUserSessionLimit);
    expect(parsed.globalSessionLimit).toBe(DEFAULT_SETTINGS.globalSessionLimit);
  });

  test("nonsensical numbers are clamped rather than accepted", () => {
    const parsed = parseSettings([
      { key: "perUserSessionLimit", value: 0 },
      { key: "globalSessionLimit", value: -5 },
      { key: "idleTimeoutMs", value: 500 },
    ]);
    expect(parsed.perUserSessionLimit).toBeGreaterThanOrEqual(1);
    expect(parsed.globalSessionLimit).toBeGreaterThanOrEqual(1);
    // A sub-second idle timeout would kill sessions the moment they start.
    expect(parsed.idleTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  test("the model can be overridden by a string setting", () => {
    expect(parseSettings([{ key: "defaultModel", value: "claude-sonnet-5" }]).defaultModel).toBe(
      "claude-sonnet-5",
    );
  });

  test("an unset model follows the configured provider, not a Claude id", () => {
    // A deployment pointed at a gateway has no use for claude-opus-5; starting
    // out with it would 404 every session until an admin noticed.
    expect(parseSettings([], "qwen3.7-plus").defaultModel).toBe("qwen3.7-plus");
  });

  test("a stored model still wins over the provider fallback", () => {
    expect(
      parseSettings([{ key: "defaultModel", value: "minimax-m3" }], "qwen3.7-plus").defaultModel,
    ).toBe("minimax-m3");
  });

  test("a blank fallback leaves the built-in default alone", () => {
    expect(parseSettings([], "  ").defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
  });
});
