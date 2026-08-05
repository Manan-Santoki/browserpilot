import { and, eq } from "drizzle-orm";
import { JOB_CONSENT_VERSION } from "@browserpilot/core";
import { jobConsents } from "@browserpilot/db";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const [consent] = await db().select().from(jobConsents)
    .where(and(eq(jobConsents.userId, user.id), eq(jobConsents.version, JOB_CONSENT_VERSION))).limit(1);
  return Response.json({ consent: consent ?? null }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  await db().insert(jobConsents).values({ userId: user.id, version: JOB_CONSENT_VERSION })
    .onConflictDoUpdate({ target: [jobConsents.userId, jobConsents.version], set: { acceptedAt: new Date(), revokedAt: null } });
  return Response.json({ ok: true, version: JOB_CONSENT_VERSION }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  await db().update(jobConsents).set({ revokedAt: new Date() })
    .where(and(eq(jobConsents.userId, user.id), eq(jobConsents.version, JOB_CONSENT_VERSION)));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
