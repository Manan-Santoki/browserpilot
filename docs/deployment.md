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

**The database is deliberately not exposed on a public port.** Application containers reach it over Dokploy's internal network. If you ever need direct access for a migration or inspection, add an external port temporarily in the Dokploy UI and remove it afterwards — do not leave it open.

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
