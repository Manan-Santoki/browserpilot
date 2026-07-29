"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { encryptSecret } from "@browserpilot/core";
import { robotSessions, siteAccounts, siteProfiles } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireAdmin, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export type FormState = { error?: string; success?: string };

/**
 * Remove a site. Sessions reference it with ON DELETE SET NULL, so history is
 * kept — a past session still shows what it did, just without a live link to
 * the target. Running sessions are refused rather than orphaned.
 */
export async function deleteSite(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  if (!siteProfileId) return;

  const live = await db()
    .select({ id: robotSessions.id })
    .from(robotSessions)
    .where(
      and(
        eq(robotSessions.siteProfileId, siteProfileId),
        inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"]),
      ),
    )
    .limit(1);

  if (live.length > 0) {
    // Deleting under a running browser would leave it driving a target the
    // console can no longer describe.
    redirect("/sites?error=running");
  }

  const [removed] = await db()
    .delete(siteProfiles)
    .where(eq(siteProfiles.id, siteProfileId))
    .returning({ name: siteProfiles.name });

  await audit({
    actorUserId: admin.id,
    action: "site.deleted",
    targetType: "site",
    targetId: siteProfileId,
    metadata: { name: removed?.name },
  });

  revalidatePath("/sites");
  redirect("/sites");
}

function masterKey(): string {
  const key = process.env.BP_MASTER_KEY;
  if (!key) throw new Error("BP_MASTER_KEY is required");
  return key;
}

/** Registering a target is an administrative act — it grants reach into another system. */
export async function createSite(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const baseUrl = String(formData.get("baseUrl") ?? "").trim().replace(/\/+$/, "");
  const cookieName = String(formData.get("cookieName") ?? "").trim() || "session";
  const secret = String(formData.get("secret") ?? "");
  const notes = String(formData.get("notes") ?? "").trim();
  const loggedOutPattern = String(formData.get("loggedOutPattern") ?? "").trim();

  // Two ways in: forge a session with the target's own signing secret, or have
  // each person sign in themselves once and keep the browser profile.
  const strategy =
    String(formData.get("loginStrategy") ?? "") === "persistent_profile"
      ? ("persistent_profile" as const)
      : ("cookie_mint" as const);

  if (!name || !baseUrl) {
    return { error: "Name and URL are both required." };
  }

  try {
    new URL(baseUrl);
  } catch {
    return { error: "That does not look like a valid URL." };
  }

  if (strategy === "cookie_mint" && !secret) {
    return {
      error:
        "A signing secret is required for cookie-mint login. It must match the target application's own session secret.",
    };
  }

  const [existing] = await db()
    .select({ id: siteProfiles.id })
    .from(siteProfiles)
    .where(eq(siteProfiles.name, name))
    .limit(1);
  if (existing) return { error: `A site called "${name}" already exists.` };

  const [site] = await db()
    .insert(siteProfiles)
    .values({
      name,
      baseUrl,
      cookieName,
      loginStrategy: strategy,
      // Sealed before it touches the table; the database alone never yields it.
      secretEncrypted: secret ? encryptSecret(secret, masterKey()) : null,
      loggedOutPattern: loggedOutPattern || null,
      systemPromptNotes: notes || null,
      createdById: admin.id,
    })
    .returning({ id: siteProfiles.id });

  await audit({
    actorUserId: admin.id,
    action: "site.created",
    targetType: "site",
    targetId: site!.id,
    metadata: { name, baseUrl, loginStrategy: strategy },
  });

  revalidatePath("/sites");
  return {
    success:
      strategy === "persistent_profile"
        ? `Registered ${name}. Sign in to it once and the robot can use it from then on.`
        : `Registered ${name}. Add your account on it to start sessions.`,
  };
}

/**
 * Record which identity this user assumes on a site. Without it the runtime
 * refuses to start a session, rather than guessing at an identity.
 */
export async function linkAccount(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  const targetUserId = String(formData.get("targetUserId") ?? "").trim();
  const targetEmail = String(formData.get("targetEmail") ?? "").trim();
  const targetName = String(formData.get("targetName") ?? "").trim();
  const targetRole = String(formData.get("targetRole") ?? "").trim() || "user";

  if (!siteProfileId || !targetUserId || !targetEmail || !targetName) {
    return { error: "Every field except role is required." };
  }

  const [site] = await db()
    .select({ id: siteProfiles.id, name: siteProfiles.name })
    .from(siteProfiles)
    .where(eq(siteProfiles.id, siteProfileId))
    .limit(1);
  if (!site) return { error: "No such site." };

  const [existing] = await db()
    .select({ id: siteAccounts.id })
    .from(siteAccounts)
    .where(and(eq(siteAccounts.siteProfileId, siteProfileId), eq(siteAccounts.userId, user.id)))
    .limit(1);

  if (existing) {
    await db()
      .update(siteAccounts)
      .set({ targetUserId, targetEmail, targetName, targetRole })
      .where(eq(siteAccounts.id, existing.id));
  } else {
    await db()
      .insert(siteAccounts)
      .values({ siteProfileId, userId: user.id, targetUserId, targetEmail, targetName, targetRole });
  }

  await audit({
    actorUserId: user.id,
    action: "site.updated",
    targetType: "site_account",
    targetId: siteProfileId,
    metadata: { targetEmail },
  });

  revalidatePath("/sites");
  return { success: `Your account on ${site.name} is set. You can start sessions now.` };
}
