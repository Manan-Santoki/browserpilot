import { and, desc, eq } from "drizzle-orm";
import { jobDocuments } from "@browserpilot/db";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { deleteJobDocument, fetchJobDocument } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

export async function GET(_request: Request, context: RouteContext<"/api/jobs/documents/[id]">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const [document] = await db().select({ id: jobDocuments.id, filename: jobDocuments.filename, contentType: jobDocuments.contentType })
    .from(jobDocuments).where(and(eq(jobDocuments.id, id), eq(jobDocuments.userId, user.id))).limit(1);
  if (!document) return Response.json({ error: "No such document" }, { status: 404 });
  const upstream = await fetchJobDocument(user, document.id);
  if (!upstream.ok || !upstream.body) return Response.json({ error: "Document unavailable" }, { status: upstream.status });
  return new Response(upstream.body, { headers: {
    "content-type": document.contentType,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
    "cache-control": "private, no-store",
  } });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/jobs/documents/[id]">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const [document] = await db().select({ id: jobDocuments.id, kind: jobDocuments.kind, isDefault: jobDocuments.isDefault })
    .from(jobDocuments).where(and(eq(jobDocuments.id, id), eq(jobDocuments.userId, user.id))).limit(1);
  if (!document) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await deleteJobDocument(user, document.id))) return Response.json({ error: "Document storage is unavailable" }, { status: 502 });
  await db().transaction(async (tx) => {
    await tx.delete(jobDocuments).where(and(eq(jobDocuments.id, document.id), eq(jobDocuments.userId, user.id)));
    if (document.kind === "resume" && document.isDefault) {
      const [replacement] = await tx.select({ id: jobDocuments.id }).from(jobDocuments)
        .where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")))
        .orderBy(desc(jobDocuments.createdAt)).limit(1);
      if (replacement) await tx.update(jobDocuments).set({ isDefault: true }).where(eq(jobDocuments.id, replacement.id));
    }
  });
  await audit({ actorUserId: user.id, action: "job.document_deleted", targetType: "job_document", targetId: id, metadata: { kind: document.kind } });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
