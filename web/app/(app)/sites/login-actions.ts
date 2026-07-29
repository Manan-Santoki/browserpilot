"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { saveRuntimeLogin, startRuntimeLogin } from "@/lib/runtime";

/**
 * Signing in to a target site yourself, so the robot can use the session
 * afterwards.
 *
 * The audit trail records that a sign-in happened and against which site. What
 * was typed during it is never seen by this application, let alone written
 * down — the keystrokes go from the browser to the target and nowhere else.
 */

export async function beginSiteLogin(formData: FormData): Promise<void> {
  const user = await requireUser();
  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  if (!siteProfileId) return;

  const [site] = await db()
    .select({ id: siteProfiles.id, name: siteProfiles.name })
    .from(siteProfiles)
    .where(eq(siteProfiles.id, siteProfileId))
    .limit(1);
  if (!site) redirect("/sites?error=unknown-site");

  // The runtime resolves a session against an account row, so a person signing
  // in to a site for the first time needs one to exist.
  const [existing] = await db()
    .select({ id: siteAccounts.id })
    .from(siteAccounts)
    .where(and(eq(siteAccounts.siteProfileId, siteProfileId), eq(siteAccounts.userId, user.id)))
    .limit(1);

  if (!existing) {
    await db().insert(siteAccounts).values({ siteProfileId, userId: user.id });
  }

  const result = await startRuntimeLogin(user, siteProfileId);
  if (!result.ok) {
    redirect(`/sites?error=${encodeURIComponent(result.error)}`);
  }

  await audit({
    actorUserId: user.id,
    action: "site.login_started",
    targetType: "site",
    targetId: siteProfileId,
    metadata: { name: site.name },
  });

  redirect(`/sites/${siteProfileId}/sign-in/${result.data.id}`);
}

export async function finishSiteLogin(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "");
  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  if (!sessionId) return;

  const result = await saveRuntimeLogin(user, sessionId);
  if (!result.ok) {
    redirect(`/sites?error=${encodeURIComponent(result.error)}`);
  }

  await audit({
    actorUserId: user.id,
    action: "site.login_saved",
    targetType: "site",
    targetId: siteProfileId,
  });

  revalidatePath("/sites");
  redirect("/sites?saved=1");
}
