import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { jobDocuments } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { uploadJobDocument } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const documents = await db().select({
    id: jobDocuments.id,
    kind: jobDocuments.kind,
    name: jobDocuments.name,
    filename: jobDocuments.filename,
    contentType: jobDocuments.contentType,
    sizeBytes: jobDocuments.sizeBytes,
    isDefault: jobDocuments.isDefault,
    sourceApplicationId: jobDocuments.sourceApplicationId,
    createdAt: jobDocuments.createdAt,
  }).from(jobDocuments).where(eq(jobDocuments.userId, user.id)).orderBy(desc(jobDocuments.createdAt));
  return Response.json({ documents }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
  const id = randomUUID();
  const uploaded = await uploadJobDocument(user, id, file);
  if (!uploaded.ok) return Response.json({ error: uploaded.error }, { status: 400 });
  const makeDefault = String(form?.get("isDefault") ?? "") === "true" || String(form?.get("isDefault") ?? "") === "on";
  await db().transaction(async (tx) => {
    if (makeDefault) await tx.update(jobDocuments).set({ isDefault: false })
      .where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")));
    await tx.insert(jobDocuments).values({
      id,
      userId: user.id,
      kind: "resume",
      name: String(form?.get("name") ?? file.name).trim().slice(0, 160) || file.name,
      filename: uploaded.data.filename,
      objectKey: uploaded.data.key,
      contentType: uploaded.data.contentType,
      sizeBytes: uploaded.data.size,
      encryptionAad: uploaded.data.encryptionAad,
      extractedTextEncrypted: uploaded.data.extractedTextEncrypted,
      isDefault: makeDefault,
    });
  });
  await audit({ actorUserId: user.id, action: "job.document_uploaded", targetType: "job_document", targetId: id, metadata: { kind: "resume", size: file.size } });
  return Response.json({ id }, { status: 201, headers: { "cache-control": "no-store" } });
}
