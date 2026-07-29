import { and, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";
import { hashToken } from "@browserpilot/core";
import { invites } from "@browserpilot/db";
import { db } from "@/lib/db";
import { AcceptForm } from "./form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const [invite] = await db()
    .select({ email: invites.email })
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        gt(invites.expiresAt, new Date()),
        isNull(invites.acceptedAt),
      ),
    )
    .limit(1);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">BrowserPilot</h1>

        {invite ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              Set a password for <span className="font-medium">{invite.email}</span>.
            </p>
            <div className="mt-8">
              <AcceptForm token={token} />
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-foreground/90">
              This invitation is invalid, already used, or expired.
            </p>
            <p className="mt-4 text-sm">
              <Link href="/login" className="underline underline-offset-4">
                Go to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
