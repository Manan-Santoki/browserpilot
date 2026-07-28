# BrowserPilot — Architecture Reference

This is the reference document for how BrowserPilot works. The [design spec](specs/2026-07-28-browserpilot-design.md) records *why* the decisions were made; the [Phase 1 plan](plans/2026-07-28-phase1-runtime-core.md) records *how* to build the first slice. This document describes the system as a whole and is the one to keep current as the code evolves.

---

## 1. What this is

An AI agent that operates websites in a **server-side headless browser**, remote-controlled from a phone. There is no browser extension, no desktop dependency, and no per-feature API integration: the agent reads and clicks the same UI a human does, so anything a person can do in the app, the robot can do.

The first target is the JWM ERP. The architecture is deliberately site-agnostic — a target site is a configuration record, not a code path.

**Three properties define the product:**

| Property | What it means |
|---|---|
| **Universal** | Driving the UI means zero per-feature tool maintenance. New ERP features are usable by the robot the day they ship, with no work on the BrowserPilot side. |
| **Supervised** | The agent asks questions when a detail is ambiguous, and requires an explicit approval tap before destructive actions. It narrates what it is doing. |
| **Observable** | The user can watch the browser live from the phone at any moment, or ask for a screenshot. Nothing happens in a black box. |

The tradeoff, stated plainly: driving a UI is slower and more token-hungry per task than calling an API directly. That cost buys universality and supervision.

---

## 2. System map

```
┌──────────────────────┐
│  Companion app       │   Expo, phone
│  chat · preview ·    │
│  approvals · files   │
└──────────┬───────────┘
           │  WSS (chat JSON + binary preview frames) + HTTPS (pairing, files)
           ▼
┌──────────────────────────────────────────────────────────────┐
│  runtime/  — one Bun process, its own Dokploy project        │
│                                                              │
│  HTTP + WS layer ── SessionManager ──┬── RobotBrowser        │
│                          │           │   (headless Chromium, │
│                          │           │    CDP port, cookie)  │
│                          │           │                       │
│                          │           └── screencast (CDP)    │
│                          │                                   │
│                          └── AgentRunner                     │
│                                ├── Claude Agent SDK          │
│                                └── Playwright MCP (stdio) ───┘
│                                        │ attaches over CDP
└────────────────────────────────────────┼─────────────────────┘
                                         ▼
                              ┌────────────────────┐
                              │  Target website    │
                              │  (JWM ERP, …)      │
                              └────────────────────┘
```

The essential shape: **the agent never talks to the target's API.** It talks to Playwright MCP, which talks to a Chromium instance, which talks to the website over ordinary HTTP as a logged-in user.

---

## 3. Components

### 3.1 `runtime/` — the service

One Bun process, deployed as its own Dokploy application, entirely separate from the ERP. It owns its storage (SQLite on a mounted volume from Phase 2 onward) so it can be deployed with no ERP present at all.

| Module | Responsibility |
|---|---|
| `src/config.ts` | Reads and validates environment configuration; resolves which AI credential is in use. |
| `src/auth/mint.ts` | Mints a target-compatible session cookie (the `cookie-mint` login strategy). |
| `src/browser/chromium.ts` | Launches headless Chromium with a CDP port, seeds the cookie, exposes the page and the downloads hook. |
| `src/browser/screencast.ts` | Starts/stops the CDP screencast that feeds live preview frames. |
| `src/agent/prompt.ts` | Builds the system prompt for a target site (operating rules + domain vocabulary + routes). |
| `src/agent/policy.ts` | Classifies each proposed tool call as auto-run or approval-required. |
| `src/agent/runner.ts` | Wraps the Claude Agent SDK: streaming input, MCP wiring, permission callback, SDK-message → `RobotEvent` mapping. |
| `src/session/manager.ts` | The registry. Session lifecycle, concurrency caps, idle/hard timeouts, event fan-out, download handling. |
| `src/session/events.ts` | The wire contract shared with every client. |
| `src/http/routes.ts` | `Bun.serve` HTTP routes and the WebSocket protocol. |

**Why the manager takes its browser, agent, and screencast as injected dependencies:** it makes the interesting logic — caps, timeouts, status transitions, approval routing, event fan-out — testable in milliseconds without launching Chromium or spending a token on a model call. The real implementations are wired in exactly once, in `src/server.ts`.

### 3.2 The agent

Claude Agent SDK running `query()` in streaming-input mode: one long-lived agent session per robot session, fed user messages as they arrive from the phone.

Two things are deliberately constrained:

- **`strictMcpConfig: true`** and no built-in tools. The agent's *entire* capability surface is the Playwright MCP tool set. It cannot read the runtime's filesystem, cannot run shell commands, cannot reach the network except through the browser it was given.
- **`canUseTool`** is the approval gate. Every proposed tool call passes through `classifyToolUse`; anything not on the read-and-interact allowlist — and any click whose target element name matches destructive wording (delete, remove, cancel, void, discard, archive, revoke, reset) — suspends the agent until the phone answers.

The agent reads pages primarily through the **accessibility tree** (`browser_snapshot`), not screenshots. This is faster, an order of magnitude cheaper in tokens, and more reliable for form-filling than pixel-based vision. Screenshots are taken when the user asks to see something, or when structure alone is insufficient.

### 3.3 The browser

One headless Chromium per session, launched by Playwright with `--remote-debugging-port`. Three consumers attach to that one browser:

1. **Playwright MCP** connects over CDP (`--cdp-endpoint`) and exposes the tools the agent calls.
2. **The screencast** uses a CDP session on the page to stream JPEG frames for the live preview.
3. **The download hook** captures files the agent downloads into a per-session directory.

The session's cookie is injected into the browser context *before* the first navigation, so the very first page load is already authenticated.

### 3.4 The companion app

An Expo app (Phase 2) whose entire job is: scan a QR to pair, list and start sessions, chat, render the live preview, answer questions and approvals, and open downloaded files. It holds a revocable device token and speaks the same protocol as the Phase 1 debug page — the debug page exists precisely so the protocol is proven before any mobile code is written.

---

## 4. Session lifecycle

```
create ──▶ starting ──▶ idle ⇄ working ⇄ awaiting_approval
                          │        │              │
                          └────────┴──────────────┴──▶ stopped / failed
```

1. **Create.** Concurrency cap is checked. A downloads directory is made. Chromium launches; a session cookie is minted and injected; the target's home page loads. The agent starts with the site's system prompt and the MCP server pointed at this browser's CDP endpoint. The session enters `idle`.
2. **Work.** A `user_msg` moves the session to `working` and is pushed into the agent's input stream. The agent emits text and tool calls; the runtime maps them to `agent_text` and `tool_activity` events and fans them out to subscribers.
3. **Approval.** A tool call classified as destructive emits `approval_request` and blocks the agent's `canUseTool` promise. The session shows `awaiting_approval` until the client answers, then resolves to allow or deny. A denial returns a message the agent sees, so it can adapt rather than crash.
4. **Downloads.** A completed download is saved under the session directory and announced with `file_ready` carrying a session-scoped URL. The file is fetched on demand, not pushed.
5. **End.** Explicit stop, idle timeout (10 min), or hard cap (60 min). The screencast stops, the agent is interrupted and closed, Chromium is closed, and the robot cookie is left to expire on its own (1 hour).

**Sessions outlive sockets.** Disconnecting the phone does not stop work; reconnecting re-subscribes and delivers current status plus a fresh preview frame. This is what makes "start a task, lock the phone, check back later" work.

---

## 5. Wire protocol

One WebSocket per session at `/ws/:sessionId`, carrying two lanes.

### Server → client (JSON text frames): `RobotEvent`

| Event | Payload | Meaning |
|---|---|---|
| `session_status` | `status`, `detail?` | Lifecycle transition. Sent once on connect. |
| `agent_text` | `text` | Something the agent said to the user. |
| `tool_activity` | `tool`, `summary` | A human-readable action line ("browser_click: New PO button"). |
| `approval_request` | `requestId`, `tool`, `summary` | Blocking; the agent is suspended until answered. |
| `approval_resolved` | `requestId`, `approved` | Confirmation, so late-joining clients can clear the card. |
| `file_ready` | `fileId`, `filename`, `url` | A download completed and is fetchable at `url`. |
| `error` | `message` | Something failed, in plain language. |

### Server → client (binary frames)

Raw JPEG bytes — one live preview frame. Sent only while preview is enabled. Clients distinguish lanes by frame type (`Blob`/binary vs string), not by any envelope.

### Client → server (JSON): `ClientCommand`

| Command | Payload | Effect |
|---|---|---|
| `user_msg` | `text` | Pushed into the agent's input stream. |
| `approval` | `requestId`, `approved` | Resolves a pending approval. |
| `preview` | `enabled` | Starts/stops the screencast for this session. |
| `stop` | — | Ends the session. |

**Preview is opt-in and cheap to toggle** because the screencast is only started when a client asks for it. A session with no one watching costs nothing in frame encoding or bandwidth.

---

## 6. Security model

The threat being designed against is not a malicious user — it is an agent that misreads a page, and a phone that could be lost.

| Control | Mechanism |
|---|---|
| **No password handling** | The robot never sees or types credentials. Its browser is authenticated by an injected, minted cookie. |
| **Scoped robot identity** | The minted token is user-scoped, session-scoped, short-lived (1 h), and carries a `robot: true` claim so robot actions are distinguishable in audit trails. |
| **Capability confinement** | No built-in agent tools; `strictMcpConfig` limits the agent to the browser tool set of one specific browser instance. |
| **Destructive-action gate** | Deny-by-default classification: unknown tools require approval, and destructive click targets require approval regardless of tool. |
| **Same validation as humans** | Every write goes through the target's own forms and API validation. The robot has no privileged write path. |
| **Revocation** | Per-session stop; per-device revoke and revoke-all from the target app's settings page (Phase 2). |
| **Transport** | WSS/HTTPS only behind the reverse proxy. |
| **Path safety** | Download filenames are flattened with `basename()` before being written or served, so a hostile suggested filename cannot escape the session directory. |

**Phase 1 caveat, stated loudly:** the runtime has *no* authentication of its own until Phase 2 adds pairing. It acts as a single configured user. It must not be exposed publicly before then — bind it to a private network or an IP allowlist.

### Secret handling

`SESSION_SECRET` and the AI credential are read from the environment, never logged, and never sent to a client. The AI credential is passed to the Agent SDK through `options.env` rather than the ambient process environment, so it is scoped to the SDK subprocess.

---

## 7. Target-site abstraction

A target site is described by a `SiteProfile`: base URL, login strategy, domain notes injected into the system prompt, and the safety rules that define "destructive" for that site.

**Login strategies:**

| Strategy | How it works | Status |
|---|---|---|
| `cookie-mint` | The runtime shares the target's JWT secret and mints a valid session cookie. Browser is born logged-in. | Phase 1 — JWM |
| `persistent-profile` | Log in manually once; Playwright storage state is saved and replayed on later sessions, exactly like your own browser staying logged in. | Planned |
| `manual-login` | The user logs in themselves through the live preview, using a remote tap/type input channel. Needed for arbitrary third-party sites. | Planned |

`cookie-mint` is the fastest and cleanest but requires owning both sides. `persistent-profile` is the realistic default for third-party sites. `manual-login` is what makes the product truly universal, and it is the one feature that requires extending the preview from view-only to interactive.

---

## 8. Operations

**Resource cost.** Headless Chromium is roughly 200–400 MB RAM per session, which is what sets the initial concurrency cap of 2. Raising the cap is a memory question, not a code one.

**Environment.**

| Variable | Purpose |
|---|---|
| `BP_JWM_URL` | Target site base URL. |
| `SESSION_SECRET` | Must be byte-identical to the target's, for `cookie-mint`. |
| `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY` | AI credential; exactly one. |
| `BP_MODEL`, `BP_PORT`, `BP_MAX_SESSIONS`, `BP_IDLE_TIMEOUT_MS`, `BP_HARD_CAP_MS`, `BP_DOWNLOADS_DIR` | Optional tuning. |

**On the AI credential:** both paths work identically at the code level (one env var). The OAuth token from `claude setup-token` bills against a Claude subscription; the API key bills per token. Anthropic's Agent SDK documentation directs products at API-key authentication, so the API key is the right choice for anything beyond personal/internal use.

**Failure modes and their handling:**

| Failure | Behavior |
|---|---|
| Agent loops or overruns | Idle timeout, hard cap, and an always-available stop. |
| Chromium crashes | Session marked failed; the user starts a fresh one. |
| Model outage or rate limit | Surfaced as an `error` event in chat, in plain language. |
| Cookie rejected (secret mismatch) | The robot lands on the login page — the single most likely misconfiguration, called out first in the runbook. |
| Client disconnects mid-approval | The agent stays suspended; reconnecting redelivers status and the pending request. |

---

## 9. Testing strategy

| Layer | Approach |
|---|---|
| Pure logic (config, minting, policy, manager) | Unit tests with injected fakes and a fake clock. Fast, deterministic, no browser, no model. |
| Browser integration | Real headless Chromium against a throwaway local HTTP fixture — verifies cookie injection, CDP reachability, and screencast frames without needing a live ERP. |
| Protocol | Real WebSocket client against the real server with a faked session manager. |
| End-to-end | A documented manual smoke test against a live target, including the negative case (deny an approval and confirm nothing happened). |

The deliberate choice throughout: **no test calls a model.** The SDK is injected via a `QueryFn` seam, so agent behavior — event mapping, approval blocking, input streaming — is verified against a scripted fake.

---

## 10. Roadmap

| Phase | Delivers | Retires |
|---|---|---|
| **1** | Runtime core: sessions, browser, agent loop, cookie-mint auth, approvals, preview, downloads, debug page. | — |
| **2** | QR pairing + device tokens, SQLite persistence, `SiteProfile` records, Expo companion app. | — |
| **3** | Voice input (push-to-talk, English/Hindi/Gujarati). | JWM's old AI workspace (`lib/ai`, `components/ai`, `/api/v1/ai`). |
| **4** | Usage hardening based on real use. | JWM's old Expo app (`mobile-app/`). |
| **Later** | `manual-login` + interactive preview, `persistent-profile`, multi-site switching. | — |

Old subsystems keep running until the phase that removes them, so there is never a capability gap and abandoning the effort is always cheap.
