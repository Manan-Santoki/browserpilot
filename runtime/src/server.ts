import { credentialEnv, loadConfig } from "./config";
import { launchRobotBrowser } from "./browser/chromium";
import { startScreencast } from "./browser/screencast";
import { startAgent } from "./agent/runner";
import { SessionManager } from "./session/manager";
import { createServer } from "./http/routes";

const config = loadConfig(process.env);

const manager = new SessionManager(
  {
    jwmUrl: config.jwmUrl,
    sessionSecret: config.sessionSecret,
    downloadsRoot: config.downloadsRoot,
    model: config.model,
    maxConcurrentSessions: config.maxConcurrentSessions,
    idleTimeoutMs: config.idleTimeoutMs,
    hardCapMs: config.hardCapMs,
    env: credentialEnv(config),
    nodeBin: config.nodeBin,
  },
  {
    now: () => Date.now(),
    launchBrowser: launchRobotBrowser,
    startAgent: (args) => startAgent(args),
    startScreencast: (page, onFrame) => startScreencast(page, onFrame),
  },
);

// Phase 1 has no pairing yet: the debug page acts as this single user.
const debugUser = {
  userId: process.env.BP_DEBUG_USER_ID ?? "",
  email: process.env.BP_DEBUG_USER_EMAIL ?? "",
  role: process.env.BP_DEBUG_USER_ROLE ?? "admin",
  name: process.env.BP_DEBUG_USER_NAME ?? "Robot Operator",
};

const { server } = createServer(manager, {
  port: config.port,
  debugUser,
  publicDir: new URL("../public", import.meta.url).pathname,
});

setInterval(() => void manager.sweep(), 30_000);

console.log(`BrowserPilot runtime listening on http://127.0.0.1:${server.port}`);
console.log(`Target: ${config.jwmUrl} — credential: ${config.aiCredential.kind}`);
