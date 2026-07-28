# BrowserPilot

An AI agent that operates websites in a **server-side headless browser**, remote-controlled from your phone. You chat (or later, talk) with the agent; it sees pages, clicks, fills forms, and downloads files on a real browser running in the cloud — with a live preview streamed to your phone, mid-task questions, and approval gates for destructive actions.

First target: the JWM ERP (private `jwm-v2` repo), where the agent creates purchase orders, fetches PO PDFs, and runs the app end to end. The architecture is site-agnostic — any website is a `SiteProfile` away.

## How it works

```
Phone (companion app) ⇄ WS: chat + preview frames ⇄ runtime (Bun)
                                                      ├─ Claude Agent SDK (agent loop)
                                                      ├─ Playwright MCP (browser tools)
                                                      └─ headless Chromium ⇄ target website
```

- **Pairing:** scan a QR (hosted by the runtime, embedded in the target app's settings) → phone gets a revocable device token.
- **Login:** pluggable per-site strategies — `cookie-mint` (JWM: runtime shares the JWT secret, browser is born logged-in), `persistent-profile`, `manual-login` (planned).
- **Live preview:** CDP screencast frames over WebSocket, on demand.
- **AI credential:** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — whichever is set.

## Repo layout

| Path | What |
|---|---|
| `runtime/` | Bun service: sessions, pairing, browser fleet, agent loop, WS server |
| `companion-app/` | Expo mobile app: QR pair, chat, live preview, files |
| `docs/specs/` | Design specs |
| `docs/plans/` | Implementation plans |

## Documentation

| Doc | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the system works: components, session lifecycle, wire protocol, security model, operations, testing, roadmap |
| [docs/specs/2026-07-28-browserpilot-design.md](docs/specs/2026-07-28-browserpilot-design.md) | The design decisions and why they were made |
| [docs/plans/2026-07-28-phase1-runtime-core.md](docs/plans/2026-07-28-phase1-runtime-core.md) | Task-by-task build plan for Phase 1 |
| [docs/running-phase1.md](docs/running-phase1.md) | How to run, smoke-test, deploy, and troubleshoot the runtime |

## Status

**Phase 1 (runtime core) is built** — sessions, headless browser with cookie-mint login, the agent loop over Playwright MCP, the approval gate, live preview, downloads, a web debug page, and a Docker image. 65 tests, no model calls in the suite. See [docs/running-phase1.md](docs/running-phase1.md) to run it.

Not yet done: device pairing (the runtime currently acts as one configured user and must not be exposed publicly), persistent storage, and the mobile companion app — all Phase 2.
