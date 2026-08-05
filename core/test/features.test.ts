import { describe, expect, test } from "bun:test";
import { isJobModeEnabled } from "../src/features";

describe("job mode feature flag", () => {
  test("defaults off in production", () => {
    expect(isJobModeEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  test("defaults on for internal development and tests", () => {
    expect(isJobModeEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isJobModeEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  test("accepts explicit operator overrides", () => {
    expect(isJobModeEnabled({ NODE_ENV: "production", BP_JOB_MODE_ENABLED: "true" })).toBe(true);
    expect(isJobModeEnabled({ NODE_ENV: "development", BP_JOB_MODE_ENABLED: "off" })).toBe(false);
  });

  test("fails closed for an unrecognized value", () => {
    expect(isJobModeEnabled({ NODE_ENV: "development", BP_JOB_MODE_ENABLED: "maybe" })).toBe(false);
  });
});
