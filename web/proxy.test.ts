import { afterEach, describe, expect, test } from "bun:test";
import { proxy } from "./proxy";

const original = process.env.BP_JOB_MODE_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.BP_JOB_MODE_ENABLED;
  else process.env.BP_JOB_MODE_ENABLED = original;
});

describe("job mode request boundary", () => {
  test("returns a generic 404 when disabled", () => {
    process.env.BP_JOB_MODE_ENABLED = "false";
    expect(proxy()?.status).toBe(404);
  });

  test("allows the matched request to continue when enabled", () => {
    process.env.BP_JOB_MODE_ENABLED = "true";
    expect(proxy()).toBeUndefined();
  });
});
