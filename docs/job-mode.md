# Job Application Mode

Job mode is an owner-isolated workspace for candidate details, encrypted résumé versions, exact-match answers, portal accounts, Gmail verification, application sessions, and reliable status notifications.

## Internal beta feature flag

Job mode is hidden by the shared `BP_JOB_MODE_ENABLED` environment flag. It defaults to enabled in development and test, and disabled in production. Both the web and runtime services must receive the same explicit value.

Set `BP_JOB_MODE_ENABLED=true` only in an internal environment that is ready to test the full workflow. When disabled, BrowserPilot removes Job Mode from navigation, returns 404 for its pages and web/runtime APIs, rejects its Server Actions, and does not run its application or notification workers. Existing database rows and encrypted objects are retained so the feature can be re-enabled without data loss.

Treat an unrecognized value as disabled. Restart both services after changing the flag.

## Production requirements

- PostgreSQL with every migration through the current `db/migrations` journal applied.
- Bun and Node.js, plus the Playwright-managed Chromium used by the runtime.
- Private local or S3-compatible object storage. Stored résumé and generated cover-letter objects are AES-256-GCM binary envelopes and must never be served directly from a public bucket.
- A configured vision-capable model and public outbound access to applicant-tracking sites and Google APIs.
- HTTPS at `BP_WEB_URL`; the exact `${BP_WEB_URL}/api/jobs/gmail/callback` URL must be registered on the Google OAuth client.
- A stable `BP_MASTER_KEY` of at least 32 characters, shared by web and runtime. Rotating or losing it makes existing private data unreadable.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` for Gmail verification and notification delivery.
- `BP_JOB_MODE_ENABLED=true` in both services. Production defaults to disabled when this is omitted.

The OAuth flow requests offline access, `gmail.readonly`, and `gmail.send`. `gmail.readonly` is a restricted scope and `gmail.send` is sensitive. A personal/test deployment can use Google's limited-user exception; a public multi-user deployment requires OAuth verification and may require an annual security assessment because restricted Gmail data passes through the server. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [web-server offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), and [verification exceptions](https://support.google.com/cloud/answer/13464323?hl=en).

## Safety and privacy invariants

- Every job query is scoped to the authenticated owner. Administrator status does not grant access to candidate data, files, Gmail data, answers, or credentials.
- Initial and subsequent browser navigation is restricted to public HTTPS destinations. CAPTCHA, non-email MFA, device confirmation, and unusual legal language require manual takeover.
- The model receives opaque placeholders for passwords, verification codes, answers, and files. Decryption and file materialization happen only immediately before browser execution; scratch files are removed when the session stops.
- Submit actions are blocked until consent, required answers, the selected staged résumé, and any required cover letter are verified server-side. Applied status additionally requires confirmation evidence.
- Queued work is durable. A runtime restart reclaims queued jobs, while a browser crash after interaction pauses the application for attention instead of risking a duplicate submission.
- Notification delivery uses a deduplicated retry outbox and never changes the underlying application outcome.

Users remain responsible for each portal's terms and anti-automation policies. Job mode does not solve or bypass CAPTCHA, MFA, or device checks.
