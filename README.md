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

## Status

Design approved — see [docs/specs/2026-07-28-browserpilot-design.md](docs/specs/2026-07-28-browserpilot-design.md). Phase 1 (runtime core, driven from a web debug page) is next.
