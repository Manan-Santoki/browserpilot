import { and, eq } from "drizzle-orm";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteSite } from "./actions";
import { beginSiteLogin } from "./login-actions";
import { AddSiteForm, LinkAccountForm } from "./forms";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const user = await requireUser();
  const { error, saved } = await searchParams;

  const sites = await db()
    .select({
      id: siteProfiles.id,
      name: siteProfiles.name,
      baseUrl: siteProfiles.baseUrl,
      cookieName: siteProfiles.cookieName,
      loginStrategy: siteProfiles.loginStrategy,
      isActive: siteProfiles.isActive,
      accountEmail: siteAccounts.targetEmail,
      linkState: siteAccounts.linkState,
      linkedAt: siteAccounts.linkedAt,
    })
    .from(siteProfiles)
    .leftJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .orderBy(siteProfiles.name);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Applications the robot can drive. Each needs you to be signed in to it before you can
          start a session.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error === "running"
            ? "That site still has a browser running. Stop the session first, then delete it."
            : error === "unknown-site"
              ? "That site no longer exists."
              : error}
        </p>
      ) : null}

      {saved ? (
        <p className="text-running text-sm">
          Sign-in saved. Sessions on that site now start already signed in.
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
                  {site.loginStrategy === "cookie_mint" ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      minted session
                    </Badge>
                  ) : null}
                  {!site.isActive ? <Badge variant="secondary">disabled</Badge> : null}
                </div>

                {site.loginStrategy === "persistent_profile" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    {site.linkState === "linked" ? (
                      <p className="text-muted-foreground text-sm">
                        <span className="lamp lamp-idle" aria-hidden /> Signed in
                        {site.linkedAt
                          ? ` since ${new Date(site.linkedAt).toLocaleDateString()}`
                          : ""}
                        .
                      </p>
                    ) : site.linkState === "expired" ? (
                      <p className="text-signal text-sm">
                        Your sign-in has expired — the robot cannot use this site until you sign in
                        again.
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        You have not signed in to this site yet.
                      </p>
                    )}

                    <form action={beginSiteLogin}>
                      <input type="hidden" name="siteProfileId" value={site.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant={site.linkState === "linked" ? "ghost" : "outline"}
                      >
                        {site.linkState === "none" ? "Sign in" : "Sign in again"}
                      </Button>
                    </form>
                  </div>
                ) : site.accountEmail ? (
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
              Anything with a web interface. How the robot gets in depends on whether you hold the
              application&apos;s signing secret or sign in to it yourself.
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
