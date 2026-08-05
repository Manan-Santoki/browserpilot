import { lookup } from "node:dns/promises";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  JOB_CONSENT_VERSION,
  decryptStructured,
  detectAts,
  normalizeJobUrl,
  resolvePublicJobUrl,
} from "@browserpilot/core";
import {
  jobApplications,
  jobBatches,
  jobCandidateProfiles,
  jobConsents,
  jobDocuments,
} from "@browserpilot/db";
import type { CurrentUser } from "@/lib/session";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

function masterKey(): string {
  const value = process.env.BP_MASTER_KEY;
  if (!value || value.length < 32) throw new Error("Private candidate data encryption is unavailable");
  return value;
}

export async function assertJobApplicationReady(userId: string, resumeId: string): Promise<void> {
  const [[resume], [profile], [consent]] = await Promise.all([
    db().select({ id: jobDocuments.id, extractedTextEncrypted: jobDocuments.extractedTextEncrypted }).from(jobDocuments)
      .where(and(eq(jobDocuments.id, resumeId), eq(jobDocuments.userId, userId), eq(jobDocuments.kind, "resume"))).limit(1),
    db().select({ profileEncrypted: jobCandidateProfiles.profileEncrypted }).from(jobCandidateProfiles)
      .where(eq(jobCandidateProfiles.userId, userId)).limit(1),
    db().select({ id: jobConsents.id }).from(jobConsents)
      .where(and(eq(jobConsents.userId, userId), eq(jobConsents.version, JOB_CONSENT_VERSION), isNull(jobConsents.revokedAt))).limit(1),
  ]);
  if (!profile) throw new Error("Complete your candidate profile before starting or retrying an application");
  const candidate = decryptStructured<Record<string, unknown>>(profile.profileEncrypted, masterKey());
  if (typeof candidate.fullName !== "string" || !candidate.fullName.trim() ||
    typeof candidate.phone !== "string" || !candidate.phone.trim() ||
    typeof candidate.city !== "string" || !candidate.city.trim() ||
    typeof candidate.country !== "string" || !candidate.country.trim()) {
    throw new Error("Add your full name, phone number, current city, and country to the candidate profile before starting or retrying");
  }
  if (!resume) throw new Error("Select one of your résumé versions");
  if (!resume.extractedTextEncrypted) throw new Error("The selected résumé has no extracted text; upload it again before starting");
  if (!consent) throw new Error("Accept the job-application consent before starting automatic applications");
}

export async function submitJobApplications(
  user: CurrentUser,
  input: { links: string[]; resumeId: string; reapply: boolean },
): Promise<Array<{ id: string; status: string; sourceUrl: string }>> {
  const links = [...new Set(input.links.map((link) => link.trim()).filter(Boolean))];
  if (links.length < 1 || links.length > 50) throw new Error("Submit between 1 and 50 job links");

  await assertJobApplicationReady(user.id, input.resumeId);
  const resume = { id: input.resumeId };

  const normalized = await Promise.all(links.map(async (sourceUrl) => {
    await resolvePublicJobUrl(sourceUrl, (hostname) => lookup(hostname, { all: true, verbatim: true }));
    return { sourceUrl, normalizedUrl: normalizeJobUrl(sourceUrl), atsKind: detectAts(sourceUrl) };
  }));

  const created = await db().transaction(async (tx) => {
    const [batch] = await tx.insert(jobBatches).values({
      userId: user.id,
      name: `Batch · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      resumeDocumentId: resume.id,
      model: user.preferredModel ?? null,
    }).returning({ id: jobBatches.id });
    const rows: Array<{ id: string; status: string; sourceUrl: string }> = [];
    for (const item of normalized) {
      const [existing] = await tx.select({ id: jobApplications.id, status: jobApplications.status })
        .from(jobApplications)
        .where(and(eq(jobApplications.userId, user.id), eq(jobApplications.normalizedUrl, item.normalizedUrl)))
        .orderBy(desc(jobApplications.createdAt)).limit(1);
      const active = existing && ["queued", "running", "needs_attention"].includes(existing.status);
      const status = existing && (!input.reapply || active) ? "not_applied" : "queued";
      const [row] = await tx.insert(jobApplications).values({
        userId: user.id,
        batchId: batch!.id,
        resumeDocumentId: resume.id,
        sourceUrl: item.sourceUrl,
        normalizedUrl: item.normalizedUrl,
        atsKind: item.atsKind,
        model: user.preferredModel ?? null,
        reapplyRequested: input.reapply,
        duplicateOfApplicationId: existing?.id ?? null,
        status,
        statusDetail: existing && (!input.reapply || active) ? `Linked to existing ${existing.status} application` : null,
        ...(existing && (!input.reapply || active) ? { finishedAt: new Date() } : {}),
      }).returning({ id: jobApplications.id, status: jobApplications.status, sourceUrl: jobApplications.sourceUrl });
      rows.push(row!);
    }
    await audit({ actorUserId: user.id, action: "job.batch_created", targetType: "job_batch", targetId: batch!.id, metadata: { count: normalized.length, reapply: input.reapply } });
    return rows;
  });
  return created;
}
