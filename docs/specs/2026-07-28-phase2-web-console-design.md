# Phase 2 — Web Console, Auth, and Postgres — Design

**Date:** 2026-07-28
**Status:** Approved (decisions confirmed); plan not yet written
**Supersedes:** the Phase 2 sketch in [the original design](2026-07-28-browserpilot-design.md) (SQLite storage, QR-pairing-first, mobile-app-first)

## Summary

Phase 1 left BrowserPilot with a working robot and no front door: sessions live in memory, and the runtime has no authentication of its own, so it cannot be exposed publicly. Phase 2 adds the front door — a Next.js web console with its own login, Postgres persistence, an admin panel, and a session viewer that shows every running browser live.

The mobile companion is still planned, but the web console comes first and becomes the primary client. The Phase 1 debug page is retired by it.

## Standalone, with no ties to JWM

BrowserPilot shares **nothing** with the JWM ERP: not a database, not a secret, not a line of code, not a deployment. It gets its own Postgres instance, its own Dokploy project, its own API keys, and its own user accounts.

JWM is simply the **first row in the `SiteProfile` table** — a target a user registers through the console, exactly like any other website they later add. Nothing in the codebase should name JWM outside of seed data and documentation examples. This is what makes the product general rather than a JWM accessory, and it is why Phase 1's `BP_JWM_URL` and shared `SESSION_SECRET` have to go.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Login | BrowserPilot's own accounts in Postgres | BrowserPilot is meant to drive sites other than JWM; coupling its identity to JWM's user table would break the moment a second target site appears. |
| Users | Team, with `ADMIN` / `USER` roles | Retrofitting privilege separation later means touching every query. Build it in from the first migration. |
| Session viewer | Live grid + detail view | "See the browsers open" — a dashboard of live thumbnails, click through to full chat, full-size preview, and approvals. |
| Database | Postgres (replaces the planned SQLite) | Its own instance, provisioned as a **separate Dokploy service** alongside the BrowserPilot apps. Shared with nothing. |
| Target sites | Added from the UI, stored in Postgres | No per-target environment variables. A user adds JWM (or any site) in the console; the runtime reads it from the database. |
| Mobile pairing | QR pairing lands in this phase | The console shows the QR; the mobile app scans it to reach the same sessions. The app itself still follows later, but the pairing API and device model ship here. |
| Voice input | In scope, via Groq Whisper (en/hi/gu) | Pulled forward from Phase 3. Whisper handles Gujarati and Hindi well, and Groq's hosting is fast and cheap enough for push-to-talk. BrowserPilot uses **its own** Groq account and key. |
| Concurrency | Per-user and global limits, admin-configurable | Phase 1's hardcoded cap of 2 was a placeholder. Limits become settings, bounded by RAM rather than by code. |

## Architecture

```
        ┌──────────────────────────────┐
        │  web/  — Next.js console     │
Browser │  login · dashboard grid ·    │
   ─────▶  session detail · admin      │
        └───────┬──────────────┬───────┘
                │ Prisma       │ mints a short-lived session ticket
                ▼              │
        ┌──────────────┐       │   Browser connects DIRECTLY to the runtime
        │  Postgres    │◀──────┼── over WSS with that ticket (chat + frames)
        │  users ·     │       │
        │  sessions ·  │       ▼
        │  devices ·   │   ┌──────────────────────────┐
        │  audit       │◀──│  runtime/ — Bun service  │
        └──────────────┘   │  browsers · agents · WS  │
                           └──────────────────────────┘
```

Two deployed services, one database. The console owns identity and history; the runtime owns browsers and agents.

**Why the browser talks to the runtime directly** rather than proxying through Next.js: preview frames are a continuous binary stream, and relaying them through a Next.js route would double the bandwidth, add latency, and make backpressure someone else's problem. The console instead mints a short-lived, signed **session ticket** (session id + user id + expiry), and the runtime verifies it on WebSocket upgrade. The console and runtime share one signing secret.

### Repo layout

| Path | What |
|---|---|
| `runtime/` | Existing Bun service — gains auth, Postgres persistence, and multi-user ownership |
| `web/` | New Next.js app (App Router, TypeScript, Tailwind) — console + admin |
| `prisma/` | Shared schema and migrations, at the repo root; both services generate from it |

## Data model

| Model | Fields (essentials) | Notes |
|---|---|---|
| `User` | id, email (unique), passwordHash, name, role (`ADMIN`/`USER`), isActive, createdAt | argon2id hashing. No public signup — invite only. |
| `WebSession` | id, userId, tokenHash, expiresAt, createdAt, lastSeenAt, userAgent, ip | Console login sessions; revocable per row. |
| `Invite` | id, email, role, tokenHash, invitedById, expiresAt, acceptedAt | Admin-issued; the only way to create an account. |
| `RobotSession` | id, userId, siteProfileId, status, startedAt, endedAt, endedReason, transcriptPath, tokensUsed | Persisted history. The runtime writes; the console reads. |
| `SessionEvent` | id, robotSessionId, seq, type, payload (jsonb), createdAt | Durable transcript, so a reconnecting client can replay. |
| `SiteProfile` | id, name, baseUrl, loginStrategy, **secretEncrypted**, systemPromptNotes, destructivePatterns, createdBy, createdAt | JWM becomes the first row rather than a hardcoded constant. `secretEncrypted` holds that site's cookie-mint signing secret (AES-256-GCM, encrypted with the master key) — this is what lets a user add a target from the UI instead of redeploying with a new env var. |
| `Setting` | key, value (jsonb), updatedBy, updatedAt | Admin-editable runtime settings: per-user session cap, global cap, idle timeout, hard cap, default model. |
| `RemoteDevice` | id, userId, name, tokenHash, createdAt, revokedAt, lastSeenAt | Reserved for the mobile companion; created here so the schema is stable. |
| `AuditLog` | id, actorUserId, action, targetType, targetId, metadata (jsonb), createdAt | Logins, session starts/stops, approvals, admin actions. |

## Web console

**Login** — email + password, argon2id, httpOnly session cookie, rate-limited. No public signup; admins invite by email.

**Dashboard** — the live grid. Every running session is a tile: live thumbnail, target site, owner, status, elapsed time, and a stop button. `USER` sees their own; `ADMIN` sees everyone's. Below it, recent finished sessions.

**Session detail** — full-size live preview beside the chat thread, with the composer, question cards, approval cards, activity feed, and downloaded files. This is the Phase 1 debug page done properly.

**New session** — pick a site profile, start, land in the detail view.

**Add a site** — name, base URL, login strategy, and (for `cookie-mint`) the target's signing secret, which is encrypted before it is stored. This is how JWM gets registered, and how the second and third target sites will be.

**Pair a phone** — a QR code containing a one-time pairing code; scanning it from the mobile app exchanges the code for a revocable device token bound to that user.

**Admin panel** (`ADMIN` only) — users (invite, deactivate, change role), all sessions with force-stop, site profiles (CRUD), devices (revoke), settings (per-user and global session caps, timeouts, default model), and the audit log.

**Design direction** — dense, calm, operational; this is a control room, not a marketing site. Dark-first with a light mode. Tailwind, a small set of hand-built primitives, no component-library sprawl. Live status is conveyed by motion (a pulsing dot, a ticking timer), not by decoration.

## Runtime changes

1. **Persistence** — sessions and their events are written to Postgres. The in-memory registry stays as the hot path; Postgres is the durable record. A restart no longer loses history (running browsers still die; those sessions are marked `interrupted` on boot).
2. **Authentication** — every endpoint requires either a console session ticket or a device token. The unauthenticated `POST /api/sessions` of Phase 1 is removed, and with it the "do not expose publicly" caveat.
3. **Ownership** — sessions belong to a user. A `USER` may only touch their own; an `ADMIN` may view and stop any.
4. **Site profiles** — the target and its system-prompt notes come from the `SiteProfile` row instead of `BP_JWM_URL` and a hardcoded prompt.
5. **Preview quality hint** — the `preview` command gains an optional profile (`thumbnail` vs `full`) so a grid of tiles can run at low fps and quality while a detail view runs at full rate. Without this a twelve-tile grid would encode twelve full-rate streams.
6. **Per-session frame fan-out** — already supported; the grid simply opens one socket per visible tile, capped and virtualized.

## Configuration — almost nothing stays in the environment

Phase 1 configured a single hardcoded target through `BP_JWM_URL`, `SESSION_SECRET`, and `BP_DEBUG_USER_*`. **All of those go away.** Users add target sites in the console, so targets, their signing secrets, and session ownership all live in Postgres.

What must remain in the environment is the small set of secrets that cannot live in the database they unlock, or that exist before any database row does:

| Variable | Why it cannot move to the database |
|---|---|
| `DATABASE_URL` | Bootstraps the database itself. |
| `BP_MASTER_KEY` | Decrypts `SiteProfile.secretEncrypted`. Storing it beside the ciphertext would defeat the encryption. |
| `BP_TICKET_SECRET` | Signs the short-lived WebSocket tickets; shared by the console and the runtime. |
| `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY` | The agent credential. |
| `GROQ_API_KEY` | Speech-to-text. |
| `BP_PORT`, `BP_NODE_BIN`, `BP_DOWNLOADS_DIR` | Process-level plumbing, not product configuration. |

Everything else — session caps, timeouts, model choice, target sites — becomes a `Setting` or `SiteProfile` row, editable in the admin panel without a redeploy.

## Concurrency

Phase 1 capped sessions at 2 globally, hardcoded. Phase 2 makes this a real policy:

- **Per-user limit** — how many browsers one person may run at once (default 3).
- **Global limit** — how many the server will run in total (default sized to the host).
- Both are `Setting` rows, editable by an admin, enforced by the runtime at session creation with a clear error rather than a generic 429.

**The real ceiling is memory, not code.** A headless Chromium session costs roughly 200–400 MB, so an 8 GB instance realistically supports 16–20 concurrent sessions, less whatever the runtime and Postgres need. The admin panel should show current usage against the limit so the number can be tuned against observed reality instead of guessed. If demand exceeds one host, the next step is a second runtime instance rather than a bigger limit — the console already talks to the runtime over HTTP, so multiple runtimes behind the same console is a natural extension (explicitly not in this phase).

## Voice input

Push-to-talk in both clients, transcribed by **Groq Whisper**, with English, Hindi, and Gujarati (`en`, `hi`, `gu`) supported from the start.

- The client records audio and posts it to the console, which proxies to Groq and returns the transcript. The runtime never sees audio.
- The transcript is shown to the user **before** it is sent to the agent, so a misheard "delete" never becomes an action. This matters more here than in a chat app: the text becomes robot actions.
- Language is a per-user preference with auto-detect as the default.

## Security

Everything from Phase 1 holds (scoped robot cookies, capability confinement, deny-by-default approvals, path-safe downloads), plus:

- Passwords argon2id; sessions are random 256-bit tokens stored hashed; cookies are httpOnly + secure + sameSite=lax.
- Session tickets for the runtime are short-lived (60 s), single-session-scoped, and signed with a secret shared only between the two services.
- Rate limiting on login and invite acceptance; lockout after repeated failures.
- The audit log records who started what, who approved what, and every admin action.
- **The runtime is no longer publicly exposed without auth** — this is the change that makes deployment safe.

## Testing

- Unit: password hashing, ticket minting/verification, role guards, invite lifecycle.
- Integration: Prisma against a disposable Postgres (Docker), covering ownership rules and the "admin sees all, user sees own" boundary.
- Protocol: ticket-authenticated WebSocket upgrade — accepted with a valid ticket, rejected when expired, wrong session, or wrong user.
- E2E (Playwright, in `web/`): log in, start a session, see a tile appear, open detail, deny an approval, stop the session.
- No test calls a model; the SDK seam from Phase 1 stays.

## Phasing within Phase 2

0. **2a — Postgres on Dokploy**: provision the database, wire `DATABASE_URL`, confirm connectivity from both services.
1. **2b — Schema and auth**: Prisma schema, migrations, user/invite/login, session cookies, roles. No UI beyond login.
2. **2c — Persistence, site profiles, and runtime auth**: runtime reads targets from `SiteProfile` (encrypted secrets), writes sessions/events to Postgres, requires tickets, enforces ownership and the new concurrency limits. The `BP_JWM_URL` / `BP_DEBUG_USER_*` variables are deleted and the debug page retired.
3. **2d — Console**: dashboard grid, session detail, new-session flow, add-a-site flow.
4. **2e — Admin panel**: users, invites, site profiles, settings (caps and timeouts), audit log, force-stop.
5. **2f — Voice and pairing**: push-to-talk with Groq Whisper transcription, and QR pairing plus the device-token API the mobile app will use.

Each sub-phase gets its own plan and ends with something usable.

## Out of scope

The mobile companion app itself (next phase — it consumes the pairing API and `RemoteDevice` model shipped here), `manual-login` / `persistent-profile` login strategies, and multiple runtime instances behind one console.

Anything concerning the JWM ERP's own codebase is out of scope permanently: BrowserPilot never modifies it, imports from it, or shares infrastructure with it.
