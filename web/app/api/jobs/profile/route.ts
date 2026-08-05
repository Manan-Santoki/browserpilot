import { eq } from "drizzle-orm";
import { decryptSecret, decryptStructured, encryptSecret, encryptStructured } from "@browserpilot/core";
import { jobCandidateProfiles } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const [stored] = await db().select().from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, user.id)).limit(1);
  if (!stored) return Response.json({ profile: null }, { headers: { "cache-control": "private, no-store" } });
  const key = process.env.BP_MASTER_KEY ?? "";
  return Response.json({
    profile: decryptStructured(stored.profileEncrypted, key),
    applicationEmail: decryptSecret(stored.applicationEmailEncrypted, key),
    notificationEmail: decryptSecret(stored.notificationEmailEncrypted, key),
    updatedAt: stored.updatedAt,
  }, { headers: { "cache-control": "private, no-store" } });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { profile?: Record<string, unknown>; applicationEmail?: string; notificationEmail?: string };
  const applicationEmail = body.applicationEmail?.trim().toLowerCase() ?? "";
  const notificationEmail = body.notificationEmail?.trim().toLowerCase() || user.email;
  if (!/^\S+@\S+\.\S+$/.test(applicationEmail) || !/^\S+@\S+\.\S+$/.test(notificationEmail)) {
    return Response.json({ error: "Valid application and notification email addresses are required" }, { status: 400 });
  }
  const profile = body.profile && typeof body.profile === "object" ? body.profile : {};
  if (typeof profile.fullName !== "string" || !profile.fullName.trim() ||
    typeof profile.phone !== "string" || !profile.phone.trim() ||
    typeof profile.city !== "string" || !profile.city.trim() ||
    typeof profile.country !== "string" || !profile.country.trim()) {
    return Response.json({ error: "Full name, phone number, current city, and country are required for automatic applications" }, { status: 400 });
  }
  const key = process.env.BP_MASTER_KEY;
  if (!key || key.length < 32) return Response.json({ error: "Private data encryption is unavailable" }, { status: 503 });
  await db().insert(jobCandidateProfiles).values({
    userId: user.id,
    profileEncrypted: encryptStructured(profile, key),
    applicationEmailEncrypted: encryptSecret(applicationEmail, key),
    notificationEmailEncrypted: encryptSecret(notificationEmail, key),
  }).onConflictDoUpdate({
    target: jobCandidateProfiles.userId,
    set: {
      profileEncrypted: encryptStructured(profile, key),
      applicationEmailEncrypted: encryptSecret(applicationEmail, key),
      notificationEmailEncrypted: encryptSecret(notificationEmail, key),
      updatedAt: new Date(),
    },
  });
  await audit({ actorUserId: user.id, action: "job.profile_updated", targetType: "job_profile", targetId: user.id });
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  await db().delete(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, user.id));
  await audit({ actorUserId: user.id, action: "job.profile_deleted", targetType: "job_profile", targetId: user.id });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
