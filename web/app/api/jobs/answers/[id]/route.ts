import { and, eq } from "drizzle-orm";
import { jobAnswers } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const id = (await context.params).id;
  const rows = await db().delete(jobAnswers).where(and(eq(jobAnswers.id, id), eq(jobAnswers.userId, user.id))).returning({ id: jobAnswers.id });
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  await audit({ actorUserId: user.id, action: "job.answer_deleted", targetType: "job_answer", targetId: id });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
