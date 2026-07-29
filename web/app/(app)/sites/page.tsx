import { and, eq } from "drizzle-orm";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteSite } from "./actions";
import { AddSiteForm, LinkAccountForm } from "./forms";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { error } = await searchParams;

  const sites = await db()
    .select({
      id: siteProfiles.id,
      name: siteProfiles.name,
      baseUrl: siteProfiles.baseUrl,
      cookieName: siteProfiles.cookieName,
      isActive: siteProfiles.isActive,
      accountEmail: siteAccounts.targetEmail,
    })
    .from(siteProfiles)
    .leftJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .orderBy(siteProfiles.name);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Applications the robot can drive. Each needs your account on it before you can start a
          session.
        </p>
      </div>

      {error === "running" ? (
        <p role="alert" className="text-sm text-destructive">
          That site still has a browser running. Stop the session first, then delete it.
        </p>
      ) : null}

      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No sites registered yet.
            {user.role === "ADMIN"
              ? " Add one below."
              : " Ask an administrator to register one."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border">
          {sites.map((site) => (
            <li key={site.id} className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 py-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{site.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">{site.baseUrl}</span>
                  {!site.isActive ? <Badge variant="secondary">disabled</Badge> : null}
                </div>

                {site.accountEmail ? (
                  <p className="text-muted-foreground mt-1 text-sm">
                    You act as <span className="text-foreground">{site.accountEmail}</span> here.
                  </p>
                ) : (
                  <details className="mt-3">
                    <summary className="text-signal cursor-pointer text-sm">
                      You have no account on this site yet — add one to start sessions
                    </summary>
                    <div className="mt-3 max-w-lg">
                      <LinkAccountForm siteProfileId={site.id} siteName={site.name} />
                    </div>
                  </details>
                )}
              </div>

              {user.role === "ADMIN" ? (
                <ConfirmAction
                  action={deleteSite}
                  fields={{ siteProfileId: site.id }}
                  label="Delete"
                  title={`Delete ${site.name}?`}
                  description="The site, everyone's accounts on it, and its stored signing secret are removed. Past sessions and their files stay, but nobody can start a new session against this site until it is registered again."
                  confirmLabel="Delete site"
                  destructive
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {user.role === "ADMIN" ? (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Register a site</CardTitle>
            <CardDescription>
              The signing secret must match the target application&apos;s own session secret — that
              is what lets the robot arrive already logged in. It is encrypted before it is stored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddSiteForm />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
