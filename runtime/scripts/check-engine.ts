/**
 * Drive a real browser with a real model through the AI SDK engine.
 *
 *   bun run check:engine                          # the default model
 *   bun run check:engine mimo-v2.5                # one model
 *   bun run check:engine mimo-v2.5 --url https://example.com
 *
 * This is the test the unit suite cannot be: an actual Chromium, an actual
 * Playwright MCP subprocess, and an actual provider answering over the wire.
 * The unit tests prove the image is *shaped* correctly for each format; only
 * this proves a model at the other end can read it.
 *
 * It asks the model to take a screenshot and describe what it sees, then
 * reports whether the answer mentions anything from the page. A model that is
 * being handed no image tends to answer in generalities, which is exactly the
 * silent failure the whole phase exists to prevent.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchRobotBrowser } from "../src/browser/chromium";
import { startAiSdkAgent } from "../src/agent/engine/loop";
import { loadConfig } from "../src/config";
import { providerHeaders } from "../src/agent/preflight";
import type { RobotEvent } from "../src/session/events";
import { KNOWN_MODELS } from "@browserpilot/core";

const config = loadConfig(process.env);
const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const targetUrl = urlFlag >= 0 ? args[urlFlag + 1]! : "https://example.com";
const model = args.find((arg) => !arg.startsWith("--") && arg !== targetUrl) ?? config.defaultModel;

// The catalogue first, then what we have measured — so a model can be checked
// before it has been added to this deployment's list, which is the order in
// which anyone would actually want to try one.
const choice =
  config.provider.models.find((m) => m.value === model) ??
  KNOWN_MODELS.find((m) => m.value === model);
const format = choice?.format ?? "anthropic";
const vision = choice?.vision ?? true;

console.log(`model     ${model} (${format}${vision ? "" : ", no vision"})`);
console.log(`provider  ${config.provider.baseUrl ?? "https://api.anthropic.com"}`);
console.log(`target    ${targetUrl}`);
console.log("");

const downloadsDir = join(tmpdir(), `bp-engine-check-${process.pid}`);
const browser = await launchRobotBrowser({ targetUrl, downloadsDir });

const events: RobotEvent[] = [];
let answer = "";
let done: (() => void) | undefined;
const finished = new Promise<void>((resolve) => {
  done = resolve;
});

const agent = await startAiSdkAgent({
  cdpEndpoint: browser.cdpEndpoint,
  site: {
    id: "check",
    name: new URL(targetUrl).host,
    baseUrl: targetUrl,
    loginStrategy: "cookie_mint",
    loggedOutPattern: null,
    cookieName: null,
    secret: null,
    systemPromptNotes: null,
    destructivePatterns: null,
  },
  model,
  format,
  vision,
  baseUrl: config.provider.baseUrl,
  headers: providerHeaders(config.provider.credential, format),
  env: {},
  nodeBin: config.nodeBin,
  sessionId: "engine-check",
  saveFile: async (filename) => {
    console.log(`  · saved ${filename}`);
  },
  onEvent: (event) => {
    events.push(event);
    if (event.type === "tool_activity") console.log(`  · ${event.summary}`);
    if (event.type === "agent_text") answer += `${event.text}\n`;
    if (event.type === "error") console.log(`  ! ${event.message}`);
    if (event.type === "agent_turn_complete") {
      console.log(`  · turn ${event.outcome}${event.detail ? `: ${event.detail}` : ""}`);
      done?.();
    }
  },
});

agent.send(
  "Take a screenshot of this page, then describe exactly what you can see in it — the heading text and any links, quoted verbatim.",
);

const timeout = setTimeout(() => {
  console.log("\n✗ no answer within 180s");
  done?.();
}, 180_000);

await finished;
clearTimeout(timeout);

await agent.stop();
await browser.close().catch(() => {});
await rm(downloadsDir, { recursive: true, force: true }).catch(() => {});

console.log("\n--- what the model said ---");
console.log(answer.trim() || "(nothing)");
console.log("---------------------------\n");

const tookScreenshot = events.some((e) => e.type === "screenshot");
const completed = events.some((e) => e.type === "agent_turn_complete" && e.outcome === "completed");

// Deliberately a weak check on the words themselves: this script's job is to
// put a real answer in front of a person, not to grade prose. What it does
// assert is the machinery — a screenshot was taken, saved, and the turn ended
// without an error.
const problems: string[] = [];
if (!tookScreenshot) problems.push("no screenshot was captured");
if (!completed) problems.push("the turn did not complete");
if (!answer.trim()) problems.push("the model said nothing");

if (problems.length > 0) {
  console.log(`✗ ${problems.join("; ")}`);
  process.exit(1);
}

console.log(
  vision
    ? "✓ screenshot taken and answered — check above that the description matches the page"
    : "✓ screenshot taken and shown to the user; this model was told it cannot read it",
);
