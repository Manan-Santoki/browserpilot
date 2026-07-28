# Phase 2 — Web Console, Auth, and Postgres — Design

**Date:** 2026-07-28
**Status:** Approved (decisions confirmed); plan not yet written
**Supersedes:** the Phase 2 sketch in [the original design](2026-07-28-browserpilot-design.md) (SQLite storage, QR-pairing-first, mobile-app-first)

## Summary

Phase 1 left BrowserPilot with a working robot and no front door: sessions live in memory, and the runtime has no authentication of its own, so it cannot be exposed publicly. Phase 2 adds the front door — a Next.js web console with its own login, Postgres persistence, an admin panel, and a session viewer that shows every running browser live.

The mobile companion is still planned, but the web console comes first and becomes the primary client. The Phase 1 debug page is retired by it.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Login | BrowserPilot's own accounts in Postgres | BrowserPilot is meant to drive sites other than JWM; coupling its identity to JWM's user table would break the moment a second target site appears. |
| Users | Team, with `ADMIN` / `USER` roles | Retrofitting privilege separation later means touching every query. Build it in from the first migration. |
| Session viewer | Live grid + detail view | "See the browsers open" — a dashboard of live thumbnails, click through to full chat, full-size preview, and approvals. |
| Database | Postgres (replaces the planned SQLite) | Already the team's database; Prisma is already familiar from JWM. One engine, not two. |

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
| `SiteProfile` | id, name, baseUrl, loginStrategy, systemPromptNotes, destructivePatterns, createdAt | JWM is the first row rather than a hardcoded constant. |
| `RemoteDevice` | id, userId, name, tokenHash, createdAt, revokedAt, lastSeenAt | Reserved for the mobile companion; created here so the schema is stable. |
| `AuditLog` | id, actorUserId, action, targetType, targetId, metadata (jsonb), createdAt | Logins, session starts/stops, approvals, admin actions. |

## Web console

**Login** — email + password, argon2id, httpOnly session cookie, rate-limited. No public signup; admins invite by email.

**Dashboard** — the live grid. Every running session is a tile: live thumbnail, target site, owner, status, elapsed time, and a stop button. `USER` sees their own; `ADMIN` sees everyone's. Below it, recent finished sessions.

**Session detail** — full-size live preview beside the chat thread, with the composer, question cards, approval cards, activity feed, and downloaded files. This is the Phase 1 debug page done properly.

**New session** — pick a site profile, start, land in the detail view.

**Admin panel** (`ADMIN` only) — users (invite, deactivate, change role), all sessions with force-stop, site profiles (CRUD), devices (revoke), and the audit log.

**Design direction** — dense, calm, operational; this is a control room, not a marketing site. Dark-first with a light mode. Tailwind, a small set of hand-built primitives, no component-library sprawl. Live status is conveyed by motion (a pulsing dot, a ticking timer), not by decoration.

## Runtime changes

1. **Persistence** — sessions and their events are written to Postgres. The in-memory registry stays as the hot path; Postgres is the durable record. A restart no longer loses history (running browsers still die; those sessions are marked `interrupted` on boot).
2. **Authentication** — every endpoint requires either a console session ticket or a device token. The unauthenticated `POST /api/sessions` of Phase 1 is removed, and with it the "do not expose publicly" caveat.
3. **Ownership** — sessions belong to a user. A `USER` may only touch their own; an `ADMIN` may view and stop any.
4. **Site profiles** — the target and its system-prompt notes come from the `SiteProfile` row instead of `BP_JWM_URL` and a hardcoded prompt.
5. **Preview quality hint** — the `preview` command gains an optional profile (`thumbnail` vs `full`) so a grid of tiles can run at low fps and quality while a detail view runs at full rate. Without this a twelve-tile grid would encode twelve full-rate streams.
6. **Per-session frame fan-out** — already supported; the grid simply opens one socket per visible tile, capped and virtualized.

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

1. **2a — Schema and auth**: Prisma schema, migrations, user/invite/login, session cookies, roles. No UI beyond login.
2. **2b — Persistence and runtime auth**: runtime writes sessions/events to Postgres, requires tickets, enforces ownership. Debug page retired.
3. **2c — Console**: dashboard grid, session detail, new-session flow.
4. **2d — Admin panel**: users, invites, site profiles, audit log, force-stop.

Each sub-phase gets its own plan and ends with something usable.

## Out of scope

Mobile companion app (next phase, reusing this API and the `RemoteDevice` model), voice input, `manual-login` / `persistent-profile` strategies, and retirement of JWM's old AI subsystem.
