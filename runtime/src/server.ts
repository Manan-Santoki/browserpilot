import { rm } from "node:fs/promises";
import { credentialEnv, loadConfig } from "./config";
import { launchRobotBrowser } from "./browser/chromium";
import { createInputSink } from "./browser/input";
import { createProfileStore } from "./browser/profiles";
import { startScreencast } from "./browser/screencast";
import { startAgent } from "./agent/runner";
import { SessionManager } from "./session/manager";
import { createServer } from "./http/routes";
import { Store } from "./store";

const config = loadConfig(process.env);
const store = new Store(config.databaseUrl, config.masterKey);

// Sessions left "live" by a crash have no browser behind them any more. Clear
// them before serving, or they show as running and consume the concurrency cap.
const orphaned = await store.markOrphansInterrupted();
if (orphaned > 0) {
  console.log(`Marked ${orphaned} session(s) interrupted after restart.`);
}

// Copies of saved profiles from a previous run are useless — their sessions
// died with the process — and they are the largest thing on the disk.
await rm(config.scratchRoot, { recursive: true, force: true }).catch(() => {});

const profiles = createProfileStore(config.profilesRoot);

const manager = new SessionManager(
  {
    downloadsRoot: config.downloadsRoot,
    scratchRoot: config.scratchRoot,
    env: credentialEnv(config),
    nodeBin: config.nodeBin,
  },
  {
    store,
    profiles,
    now: () => Date.now(),
    launchBrowser: launchRobotBrowser,
    startAgent: (args) => startAgent(args),
    startScreencast: (context, onFrame, opts) => startScreencast(context, onFrame, opts),
    createInput: (page) => createInputSink(page),
  },
);

const { server } = createServer(manager, {
  port: config.port,
  ticketSecret: config.ticketSecret,
  store,
  downloadsRoot: config.downloadsRoot,
});

setInterval(() => void manager.sweep().catch(() => {}), 30_000);

console.log(`BrowserPilot runtime listening on http://127.0.0.1:${server.port}`);
console.log(`Targets come from the database — credential: ${config.aiCredential.kind}`);
