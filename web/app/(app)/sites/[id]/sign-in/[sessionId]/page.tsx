import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { finishSiteLogin } from "../../../login-actions";
import { SignInPanel } from "./panel";

export default async function SiteSignInPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  await requireUser();
  const { id, sessionId } = await params;

  const [site] = await db()
    .select({ id: siteProfiles.id, name: siteProfiles.name, baseUrl: siteProfiles.baseUrl })
    .from(siteProfiles)
    .where(eq(siteProfiles.id, id))
    .limit(1);
  if (!site) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/sites"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Sites
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Sign in to {site.name}</h1>
        <p className="text-muted-foreground mt-1 font-mono text-xs">{site.baseUrl}</p>
      </div>

      <SignInPanel
        sessionId={sessionId}
        siteProfileId={site.id}
        siteName={site.name}
        save={finishSiteLogin}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Sign in as you normally would</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground px-4 text-sm">
            Password, one-time code, or a redirect to another provider — all of it works, because
            a real browser is doing it. Click the page first, then type. Paste works too.
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Your password is never stored</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground px-4 text-sm">
            Keystrokes go to the browser and nowhere else — not the transcript, the event log, or
            the audit trail. What is kept is the session {site.name} hands back.
          </CardContent>
        </Card>

        <Card className="gap-2 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Sessions expire</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground px-4 text-sm">
            When {site.name} eventually ends the saved session, the robot stops and asks you to
            sign in here again.{" "}
            <Link href="/sites" className="underline underline-offset-4">
              Leave without saving
            </Link>
            .
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
