# Running Phase 1

## Local

1. `cd runtime && cp .env.example .env`
2. Fill in `.env`:
   - `BP_JWM_URL` — the JWM deployment to drive.
   - `SESSION_SECRET` — must be byte-identical to that deployment's `SESSION_SECRET`, or the minted cookie is rejected and the robot lands on `/login`.
   - `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) **or** `ANTHROPIC_API_KEY`.
   - `BP_DEBUG_USER_ID` / `BP_DEBUG_USER_EMAIL` / `BP_DEBUG_USER_NAME` — an existing JWM user; the id must be that user's UUID.
   - `BP_NODE_BIN` — only if a bare `node` isn't the right binary. **On WSL you almost certainly need this**, pointed at the Linux node (`which node`); see Troubleshooting.
3. `bunx playwright install --with-deps chromium` (first run only)
4. `bun run dev`, then open `http://127.0.0.1:8787`.

## Manual smoke test

1. Click **New session**. Within a few seconds the status line reads `idle`.
2. Tick **Live preview** — the right pane shows the JWM dashboard, already logged in. If it shows the login page, `SESSION_SECRET` does not match.
3. Type: `open purchase orders and tell me how many are active`. Watch the tool activity lines; the agent should answer with a number.
4. Type: `download the PDF for the most recent purchase order`. A file card appears in the log; clicking it downloads the PDF.
5. Type: `delete the oldest scrap entry`. An **Approve / Deny** card must appear before anything is clicked. Press **Deny** and confirm the agent reports it did not proceed.
6. Click **Stop**. The status line reads `stopped`; `ps aux | grep chrome` shows the Chromium process gone.

## Docker

```bash
cd runtime
docker build -t browserpilot-runtime .
docker run --rm -p 8787:8787 --env-file .env \
  -v "$PWD/downloads:/app/downloads" \
  -e BP_DOWNLOADS_DIR=/app/downloads \
  browserpilot-runtime
```

## Dokploy

Deploy `runtime/` as its own application, separate from the JWM project:

- Build: Dockerfile at `runtime/Dockerfile`.
- Port: `8787`.
- Env: the same variables as `.env` above.
- Volume: mount a persistent path at `/app/downloads` and set `BP_DOWNLOADS_DIR=/app/downloads`.
- Enable HTTPS on the domain — Phase 2's companion app requires WSS.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Preview shows the JWM **login page** | `SESSION_SECRET` does not match the target deployment's. This is the most common misconfiguration. |
| `POST /api/sessions` returns 500 with `userId must be a UUID` | `BP_DEBUG_USER_ID` is not a real user UUID from the JWM database. |
| Session starts but the agent never replies | The AI credential is missing or invalid. Check the container logs for an SDK authentication error. |
| `POST /api/sessions` returns 429 | Both session slots are in use. Stop one, or raise `BP_MAX_SESSIONS` (each session costs ~200–400 MB RAM). |
| Chromium fails to launch locally | Run `bunx playwright install --with-deps chromium`. Inside Docker this is already handled by the Playwright base image. |
| Agent replies "No open pages available", or acts on a logged-out browser | The MCP server failed to attach to our browser and started its own. Set `BP_NODE_BIN` to a **Linux** node binary (`which node`). Playwright's `connectOverCDP` never completes its handshake under Bun, and on WSL a bare `node`/`npx` can resolve to the Windows build. |

## Known Phase 1 limits

- No pairing, no auth on the runtime's own endpoints: it acts as the single `BP_DEBUG_USER_*` user. **Do not expose it publicly yet** — bind it to a private network or an IP allowlist until Phase 2 adds device pairing.
- Sessions are in-memory; a restart drops them.
- One browser page per session; the agent does not open tabs.
