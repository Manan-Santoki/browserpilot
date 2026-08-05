import { afterAll, describe, expect, test } from "bun:test";
import type { SessionManager } from "../src/session/manager";
import type { Store } from "../src/store";
import type { ObjectStore } from "../src/storage/object-store";
import { createServer } from "../src/http/routes";

const running = createServer({} as SessionManager, {
  port: 0,
  ticketSecret: "unused-for-disabled-job-routes",
  store: {} as Store,
  objects: async () => ({} as ObjectStore),
  storageEnv: {},
  providerEnv: {},
  downloadsRoot: "/tmp/browserpilot-disabled-job-mode",
  jobModeEnabled: false,
});

afterAll(() => running.stop());

describe("disabled runtime job mode", () => {
  test("keeps the health endpoint available", async () => {
    expect((await fetch(`http://127.0.0.1:${running.server.port}/health`)).status).toBe(200);
  });

  test("hides job endpoints before authentication", async () => {
    expect((await fetch(`http://127.0.0.1:${running.server.port}/api/job-documents`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${running.server.port}/api/sessions/hidden/job-answer`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${running.server.port}/api/sessions/hidden/takeover`)).status).toBe(404);
  });

  test("does not alter ordinary runtime authentication", async () => {
    expect((await fetch(`http://127.0.0.1:${running.server.port}/api/sessions`)).status).toBe(401);
  });
});
