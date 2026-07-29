import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

/** Sites this person can start a session on, and whether they actually can. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const rows = await db()
    .select({
      id: siteProfiles.id,
      name: siteProfiles.name,
      baseUrl: siteProfiles.baseUrl,
      loginStrategy: siteProfiles.loginStrategy,
      isActive: siteProfiles.isActive,
      linkState: siteAccounts.linkState,
      accountEmail: siteAccounts.targetEmail,
    })
    .from(siteProfiles)
    .leftJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .orderBy(siteProfiles.name);

  return NextResponse.json({
    sites: rows.map((row) => ({
      ...row,
      // Signing in has to happen at a real keyboard, so the app says whether a
      // site is usable rather than offering a flow it cannot finish.
      ready:
        row.isActive &&
        (row.loginStrategy === "persistent_profile"
          ? row.linkState === "linked"
          : row.accountEmail !== null),
    })),
  });
}
