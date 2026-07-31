import { rm } from "node:fs/promises";
import { describeProvider, loadConfig, providerEnv } from "./config";
import { launchRobotBrowser } from "./browser/chromium";
import { createInputSink } from "./browser/input";
import { createProfileStore } from "./browser/profiles";
import { startScreencast } from "./browser/screencast";
import { createLocalStore, createS3Store, type ObjectStore } from "./storage/object-store";
import { storageEnv } from "./storage/settings";
import { startAgent } from "./agent/runner";
import { checkProvider, formatCheck } from "./agent/preflight";
import { SessionManager } from "./session/manager";
import { createServer } from "./http/routes";
import { Store } from "./store";

const config = loadConfig(process.env);
const store = new Store(config.databaseUrl, config.masterKey, config.defaultModel);

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

/**
 * Where downloads go, decided from the environment and whatever an
 * administrator has since saved. Rebuilt only when that answer changes, so
 * editing the settings takes effect without a redeploy and without paying for
 * a new client on every download.
 */
let cached: { signature: string; store: ObjectStore } | undefined;
async function objects(): Promise<ObjectStore> {
  const settings = await store.storageSettings(storageEnv(process.env));
  const signature = JSON.stringify(settings);
  if (cached?.signature !== signature) {
    cached = {
      signature,
      store:
        settings.driver === "s3"
          ? createS3Store(settings.s3)
          : createLocalStore(config.downloadsRoot),
    };
  }
  return cached.store;
}

const manager = new SessionManager(
  {
    downloadsRoot: config.downloadsRoot,
    scratchRoot: config.scratchRoot,
    env: providerEnv(config),
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
    objects,
  },
);

const { server } = createServer(manager, {
  port: config.port,
  ticketSecret: config.ticketSecret,
  store,
  objects,
  storageEnv: storageEnv(process.env),
  downloadsRoot: config.downloadsRoot,
});

setInterval(() => void manager.sweep().catch(() => {}), 30_000);

console.log(`BrowserPilot runtime listening on http://127.0.0.1:${server.port}`);
console.log(`Targets come from the database — provider: ${describeProvider(config)}`);

// Reported, not enforced: a provider that is briefly unreachable should not
// stop a service whose sessions, files and console are all fine. The point is
// that a misrouted base URL or a token in the wrong header shows up here
// rather than as an agent that silently never answers.
void checkProvider(config)
  .then((check) => console[check.ok ? "log" : "warn"](formatCheck(check)))
  .catch(() => {});
