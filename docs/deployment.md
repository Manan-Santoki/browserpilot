# Deployment

BrowserPilot runs as its own Dokploy project, sharing nothing with any other application.

## Provisioned so far

| Resource | Value |
|---|---|
| Dokploy project | `browserpilot` (`7ZmuTJ6S8sxZE7OIdeSyu`) |
| Environment | `production` (`dwH1vgGszZz04Y-R2Fy8n`) |
| Database service | `browserpilot-postgres` (`lFcULMvMvvTTmyZ2jzvRJ`), postgres:17 |
| Internal host | `browserpilot-postgres-sv6isw` |
| Database / user | `browserpilot` / `browserpilot` |
| Volume | `browserpilot-postgres-sv6isw-data` mounted at `/var/lib/postgresql/data` |

Production `DATABASE_URL` (services on the same Dokploy network reach it by service name; the password lives in Dokploy, not in this repo):

```
postgresql://browserpilot:<password>@browserpilot-postgres-sv6isw:5432/browserpilot
```

The runtime container applies committed Drizzle migrations before starting.
Deploy or restart the runtime before sending traffic to a web image that uses a
new schema. For a manual deployment, run `bun run db:migrate` once with the
same `DATABASE_URL` used by both services.

Job Mode is an internal beta and fails closed in production. Leave
`BP_JOB_MODE_ENABLED` unset (or set it to `false`) in both production services
to hide its navigation and return 404 from its pages and endpoints. Internal
test deployments must set `BP_JOB_MODE_ENABLED=true` on both web and runtime;
restart both services after changing it.

### External access (development)

The database is also published on **`46.4.244.39:5433`** so migrations and local development can run against the live instance. The account has a 32-character random password and the database holds no third-party data, but this is still a database open to the internet.

**Close this port once the console is deployed** — set the external port to `null` and redeploy. From then on the application containers reach Postgres over Dokploy's internal network by service name, which needs no public exposure at all.

## Still to provision

- `browserpilot-runtime` — the Bun service (Dockerfile at `runtime/Dockerfile`), needs a volume at `/app/downloads`.
- `browserpilot-web` — the Next.js console.
- A domain each, with HTTPS. The console needs it for secure cookies; the runtime needs it for WSS.

## Local development

Use a disposable local database rather than the production one:

```bash
docker run -d --name browserpilot-dev-db \
  -e POSTGRES_USER=browserpilot -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=browserpilot -p 55432:5432 postgres:17
```

```
DATABASE_URL=postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot
```

Migrations are developed against this instance and applied to production on deploy.
