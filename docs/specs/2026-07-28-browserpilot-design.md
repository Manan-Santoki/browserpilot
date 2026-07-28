# BrowserPilot — Design

**Date:** 2026-07-28
**Status:** Approved
**Author:** Manan Santoki + Claude
**Repo:** `browserpilot` (this repo — standalone product; JWM is the first target site, its ERP lives in the separate `jwm-v2` repo)

## Summary

A browser-native AI agent ("the robot") that operates the JWM web app the way a human does — sees pages, clicks, fills forms, downloads PDFs — driven from a phone. The user pairs a new lightweight companion mobile app by scanning a QR code in the JWM web app, then chats with the robot and watches a live preview of the browser it controls. The robot asks questions mid-task when it needs input and requires explicit approval for destructive actions.

This replaces, over time, both the current tool-calling AI subsystem (`lib/ai`, `components/ai`, `/api/v1/ai`) and the current Expo mobile app (`mobile-app/`). Neither is removed up front — see Phasing.

## Goals

- Prompt-driven operation of the real JWM UI: create POs, fetch PO PDFs, look things up, "almost everything else".
- Live preview of the robot's browser on the phone.
- Human-in-the-loop: the robot asks clarifying questions and requests approval for destructive actions.
- Phone-only usage: no desktop needs to be open.
- Text prompts in v1; voice (English/Hindi/Gujarati push-to-talk) in v1.1.

## Non-goals (v1)

- Driving the user's own desktop browser (server-side headless only).
- Multi-tenant / external users — this is for JWM's own paired users.
- Voice input (v1.1), old-subsystem removal (Phase 3+).

## Engine decision

**Claude Agent SDK + Playwright MCP**, self-hosted in a new Bun service. Rationale:

- Officially documented pattern (Agent SDK docs demo browser automation via `@playwright/mcp`).
- Accessibility-tree driving (fast, cheap, reliable); screenshots only when vision is needed.
- The SDK provides the agent loop, streaming, sessions, permission hooks, and question flow — none of it hand-built.
- TypeScript end-to-end, matching the repo.
- Credential is configurable: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, Max subscription) **or** `ANTHROPIC_API_KEY`, whichever is set. Note: Anthropic's Agent SDK docs direct products to API-key auth; the OAuth token path is acceptable for personal/internal use and is a one-env-var swap either way.

Alternatives considered: `browser-use` (Python sidecar; would reuse the OpenRouter key but adds a Python service and leaves preview/pairing/approvals hand-built) and a raw computer-use pixel loop (most literal but slowest, most expensive, most fragile). Both rejected.

## Architecture

```
┌─────────────┐  QR pair   ┌──────────────────┐   WS: chat + frames   ┌──────────────┐
│ JWM web app │──────────▶ │  Companion app    │◀─────────────────────▶│ agent-runtime │
│ (Next.js)   │  (shows QR)│  (new Expo app)   │                       │ (Bun service) │
└─────▲───────┘            └──────────────────┘                       │  Claude Agent │
      │  robot browses the real app                                   │  SDK +        │
      │  (headless Chromium, minted jwm-session cookie)               │  Playwright   │
      └───────────────────────────────────────────────────────────────┴──MCP──────────┘
```

### Components

1. **`runtime/`** (in this repo — the agent-runtime Bun service, deployed as its own Dokploy project):
   - HTTP + WebSocket server behind the existing reverse proxy (WSS only).
   - Endpoints: `POST /pair/start` (authenticated by verifying the caller's `jwm-session` cookie with the shared JWT secret; issues one-time pairing code), `POST /pair/claim` (companion exchanges code → device token), `POST /sessions`, `WS /sessions/:id/stream`, `POST /sessions/:id/{message,approve,stop}`, device list/revoke.
   - Session manager: concurrency cap (default 2), 10-min idle timeout, 60-min hard cap, per-session token budget.
   - Per session: launches headless Chromium with a CDP port; Playwright MCP attaches via `--cdp-endpoint`; a second CDP connection runs `Page.startScreencast` for the preview.
   - **Owns its own storage** (SQLite on a Dokploy volume — no dependency on JWM's Postgres, so the runtime deploys standalone): `RemoteDevice` (paired phone: user, token hash, name, createdAt, revokedAt), `RobotSession` (user, device, target, status, startedAt/endedAt, transcript path), `SiteProfile` (see Target-site abstraction), persisted browser profiles.
2. **JWM web app** (`jwm-v2` repo) — one addition: Settings → **Remote Control** page embedding the runtime-hosted pairing QR and device list with revoke. The robot otherwise uses the app unchanged.
3. **`companion-app/`** (in this repo) — minimal Expo + TypeScript app (replaces jwm-v2's `mobile-app/` over time). Screens: Pair (QR scan), Home (sessions + new session), Session (chat + collapsible live preview, question/approval cards), Files (downloads with share sheet).
4. **Claude Agent SDK** — `query()` in streaming-input mode, one SDK session per robot session. Tools restricted to Playwright MCP tools. System prompt describes JWM routes and domain vocabulary (PO, warping, FG, dispatch, enquiry…), download locations, and the operating rules: act via the UI only; ask when unsure; require approval before destructive actions; announce completed work.

### Robot session lifecycle

1. Paired phone taps **New session** → cap check → Chromium launch → runtime mints a short-lived `jwm-session` JWT for the paired user (shares the app's jose secret; carries `robot: true` for auditability) → cookie set → dashboard opened.
2. Agent loop starts. User messages: phone → WS → agent. Agent drives the browser via accessibility snapshots/click/type/navigate, screenshots on demand.
3. Agent questions surface as chat cards with quick-reply options (SDK question/permission hooks mapped to WS events). Approvals likewise.
4. Downloads land in a per-session dir; the phone gets a `file_ready` event with a download URL.
5. End: user tap, idle timeout, or hard cap → Chromium killed, robot JWT expires, `RobotSession` closed. Transcripts persist (SDK JSONL + DB row).

### WS protocol

One socket per session, two lanes:

- **Chat lane (JSON):** `user_msg`, `agent_text` (streamed), `agent_question` (options + free text), `approval_request`, `tool_activity` (human-readable "clicking Create PO…"), `file_ready`, `session_status`, heartbeat.
- **Preview lane (binary):** CDP screencast JPEG frames, ~4–6 fps, quality ~60, phone-sized. Screencast pauses when no client is attached.
- Reconnect: rejoin delivers last N chat events + a fresh keyframe. Sessions are independent of the socket — the robot keeps working while the phone is away.

## Target-site abstraction (generalization seams)

The runtime is deliberately **not** JWM-specific: the agent only ever uses a browser, so any website is controllable. v1 ships with JWM as the only target, but three seams keep generalization cheap:

1. **`SiteProfile`** — per-target config: base URL, login strategy, domain notes for the system prompt, safety rules (what counts as destructive). JWM is the first profile; new sites are new profiles, not new code.
2. **Pluggable login strategies:** `cookie-mint` (JWM only — shared JWT secret), `manual-login` (user logs in via the live preview using a remote tap/type input channel on the preview), and `persistent-profile` (Playwright storage state saved after one manual login, so later sessions wake up already authenticated). v1 implements `cookie-mint`; the interface accommodates the rest.
3. **Standalone pairing:** the runtime hosts its own pairing page/QR; the JWM settings page embeds it rather than owning it.

Deployment: JWM ERP and the agent-runtime are **separate Dokploy projects**. The runtime is self-contained (own storage volume); its only ties to JWM are env config (`APP_URL`, shared JWT secret) and one embedded settings page.

## Security

- One-time pairing codes (5-min TTL) issued only to a logged-in JWM web session; exchanged for a revocable long-lived device token (hash stored).
- Robot JWTs are session-scoped, short-lived, user-scoped, marked `robot: true`.
- Destructive actions (delete, cancel, void) hard-gated on phone approval; creates/edits announced.
- Kill switches: End session (per session), revoke device / revoke all (settings page).
- Runtime is WSS-only behind the reverse proxy; no password ever passes through the robot.

## Error handling

- Stuck/looping agent: token budget + hard cap + interruptible End session; failures post a plain-language chat message.
- Browser crash: session marked failed; one-tap fresh session.
- Model provider outage/rate limit: surfaced in chat with retry; WS heartbeat prevents silent hangs.
- Data mistakes: approval gates + announce rule; all robot writes pass through the same API validation as human users.

## Testing

- **Unit (runtime):** pairing exchange, revocation, JWT minting/claims, session caps/timeouts.
- **Integration (no model):** launch real headless Chromium against dev server, inject cookie, assert logged-in dashboard.
- **E2E smoke (model-in-loop, manual/gated):** "create a PO for test supplier X and download its PDF" against dev, asserted via DB.
- Companion app: manual testing in v1.

## Phasing

1. **Phase 1 — agent-runtime core:** sessions, browser, agent loop, cookie auth, driven from a bare-bones web debug page (chat + preview in a browser). Proves the robot before any mobile work.
2. **Phase 2 — pairing + companion app:** QR flow, Expo app, files.
3. **Phase 3 — voice (push-to-talk EN/HI/GU) + remove the old AI workspace (`components/ai`, `lib/ai/tools`, `/api/v1/ai/chat`; keep `speech` STT). `APP_VERSION` bump.**
4. **Phase 4 — retire `mobile-app/`** once the companion covers real usage.

Each phase gets its own implementation plan. Old subsystems run alongside until their phase removes them, so there is no capability gap and an easy abort.

## Operational notes

- Headless Chromium ≈ 200–400 MB RAM per session — hence the cap of 2 concurrent sessions initially.
- The runtime needs: the app's JWT secret, `APP_URL`, one of the two AI credentials, Chromium (Playwright's bundled build), and DB access.
- Cost/speed expectation: a browser-driving agent is slower and more token-hungry per task than the old tool-calling agent; the trade is universality (it can do anything the UI can) and zero per-feature tool maintenance.
