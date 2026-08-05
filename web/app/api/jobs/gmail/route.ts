import { and, eq } from "drizzle-orm";
import { jobConnections } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const [connection] = await db().select({
    accountEmail: jobConnections.accountEmail,
    scope: jobConnections.scope,
    state: jobConnections.state,
    lastUsedAt: jobConnections.lastUsedAt,
    revokedAt: jobConnections.revokedAt,
    createdAt: jobConnections.createdAt,
    updatedAt: jobConnections.updatedAt,
  }).from(jobConnections).where(and(eq(jobConnections.userId, user.id), eq(jobConnections.kind, "gmail"))).limit(1);
  return Response.json({ connection: connection ?? null }, { headers: { "cache-control": "private, no-store" } });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  await db().delete(jobConnections).where(and(eq(jobConnections.userId, user.id), eq(jobConnections.kind, "gmail")));
  await audit({ actorUserId: user.id, action: "job.gmail_disconnected", targetType: "job_connection", targetId: user.id });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
