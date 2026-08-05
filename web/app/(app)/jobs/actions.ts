"use server";

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  JOB_CONSENT_VERSION,
  encryptSecret,
  encryptStructured,
  jobAnswerMatchKey,
  jobOptionSignature,
  validateJobAnswer,
  type JobAnswerType,
} from "@browserpilot/core";
import {
  jobAnswers,
  jobApplications,
  jobCandidateProfiles,
  jobConnections,
  jobConsents,
  jobDocuments,
  jobPortalAccounts,
  jobQuestions,
  robotSessions,
} from "@browserpilot/db";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { deleteJobDocument as deleteRuntimeJobDocument, finishJobTakeover, sendJobAnswer, stopRuntimeSession, uploadJobDocument } from "@/lib/runtime";
import { enqueueJobNotification } from "@/lib/job-notifications";
import { assertJobApplicationReady, submitJobApplications } from "@/lib/job-applications";
import { requireJobModeEnabled } from "@/lib/job-mode";

function masterKey(): string {
  const value = process.env.BP_MASTER_KEY;
  if (!value || value.length < 32) throw new Error("BP_MASTER_KEY is required for private job data");
  return value;
}

async function requireJobPermission() {
  requireJobModeEnabled();
  return requirePermission("job.apply");
}

export async function acceptJobConsent(): Promise<void> {
  const user = await requireJobPermission();
  await db().insert(jobConsents).values({ userId: user.id, version: JOB_CONSENT_VERSION })
    .onConflictDoUpdate({
      target: [jobConsents.userId, jobConsents.version],
      set: { acceptedAt: new Date(), revokedAt: null },
    });
  revalidatePath("/jobs");
}

export async function submitJobLinks(formData: FormData): Promise<void> {
  const user = await requireJobPermission();
  const resumeId = String(formData.get("resumeId") ?? "");
  const raw = String(formData.get("links") ?? "");
  const reapply = formData.get("reapply") === "on";
  await submitJobApplications(user, { links: raw.split(/\r?\n|,/), resumeId, reapply });
  revalidatePath("/jobs");
}

export async function saveCandidateProfile(formData: FormData): Promise<void> {
  const user = await requireJobPermission();
  const applicationEmail = String(formData.get("applicationEmail") ?? "").trim().toLowerCase();
  const notificationEmail = String(formData.get("notificationEmail") ?? user.email).trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(applicationEmail) || !/^\S+@\S+\.\S+$/.test(notificationEmail)) {
    throw new Error("Valid application and notification email addresses are required");
  }
  const profile = {
    fullName: String(formData.get("fullName") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim(),
    address: String(formData.get("address") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    region: String(formData.get("region") ?? "").trim(),
    postalCode: String(formData.get("postalCode") ?? "").trim(),
    country: String(formData.get("country") ?? "").trim(),
    linkedin: String(formData.get("linkedin") ?? "").trim(),
    github: String(formData.get("github") ?? "").trim(),
    portfolio: String(formData.get("portfolio") ?? "").trim(),
    workAuthorization: String(formData.get("workAuthorization") ?? "").trim(),
    sponsorship: String(formData.get("sponsorship") ?? "").trim(),
    locationPreferences: String(formData.get("locationPreferences") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    relocation: formData.get("relocation") === "on",
    salaryPreference: String(formData.get("salaryPreference") ?? "").trim(),
    availability: String(formData.get("availability") ?? "").trim(),
    summary: String(formData.get("summary") ?? "").trim(),
    employmentHistory: String(formData.get("employmentHistory") ?? "").trim(),
    education: String(formData.get("education") ?? "").trim(),
    school: String(formData.get("school") ?? "").trim(),
    degree: String(formData.get("degree") ?? "").trim(),
    discipline: String(formData.get("discipline") ?? "").trim(),
    educationStartYear: String(formData.get("educationStartYear") ?? "").trim(),
    educationEndYear: String(formData.get("educationEndYear") ?? "").trim(),
    skills: String(formData.get("skills") ?? "").trim(),
    projects: String(formData.get("projects") ?? "").trim(),
    certifications: String(formData.get("certifications") ?? "").trim(),
  };
  if (!profile.fullName || !profile.phone || !profile.city || !profile.country) {
    throw new Error("Full name, phone number, current city, and country are required for automatic applications");
  }
  const key = masterKey();
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
  revalidatePath("/jobs");
}

export async function deleteCandidateProfile(): Promise<void> {
  const user = await requireJobPermission();
  await db().delete(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, user.id));
  await audit({ actorUserId: user.id, action: "job.profile_deleted", targetType: "job_profile", targetId: user.id });
  revalidatePath("/jobs");
}

export async function uploadResume(formData: FormData): Promise<void> {
  const user = await requireJobPermission();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new Error("Choose a PDF or DOCX résumé");
  const id = randomUUID();
  const uploaded = await uploadJobDocument(user, id, file);
  if (!uploaded.ok) throw new Error(uploaded.error);
  const makeDefault = formData.get("isDefault") === "on";
  await db().transaction(async (tx) => {
    if (makeDefault) await tx.update(jobDocuments).set({ isDefault: false })
      .where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")));
    await tx.insert(jobDocuments).values({
      id,
      userId: user.id,
      kind: "resume",
      name: String(formData.get("name") ?? file.name).trim().slice(0, 160) || file.name,
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
  revalidatePath("/jobs");
}

export async function setDefaultResume(documentId: string): Promise<void> {
  const user = await requireJobPermission();
  const [owned] = await db().select({ id: jobDocuments.id }).from(jobDocuments)
    .where(and(eq(jobDocuments.id, documentId), eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume"))).limit(1);
  if (!owned) return;
  await db().transaction(async (tx) => {
    await tx.update(jobDocuments).set({ isDefault: false }).where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")));
    await tx.update(jobDocuments).set({ isDefault: true }).where(eq(jobDocuments.id, owned.id));
  });
  revalidatePath("/jobs");
}

export async function deleteCandidateDocument(documentId: string): Promise<void> {
  const user = await requireJobPermission();
  const [owned] = await db().select({ id: jobDocuments.id, kind: jobDocuments.kind, isDefault: jobDocuments.isDefault })
    .from(jobDocuments).where(and(eq(jobDocuments.id, documentId), eq(jobDocuments.userId, user.id))).limit(1);
  if (!owned) return;
  if (!(await deleteRuntimeJobDocument(user, owned.id))) throw new Error("The encrypted document could not be removed from storage");
  await db().transaction(async (tx) => {
    await tx.delete(jobDocuments).where(and(eq(jobDocuments.id, owned.id), eq(jobDocuments.userId, user.id)));
    if (owned.kind === "resume" && owned.isDefault) {
      const [replacement] = await tx.select({ id: jobDocuments.id }).from(jobDocuments)
        .where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")))
        .orderBy(desc(jobDocuments.createdAt)).limit(1);
      if (replacement) await tx.update(jobDocuments).set({ isDefault: true }).where(eq(jobDocuments.id, replacement.id));
    }
  });
  await audit({ actorUserId: user.id, action: "job.document_deleted", targetType: "job_document", targetId: owned.id, metadata: { kind: owned.kind } });
  revalidatePath("/jobs");
}

export async function saveApplicationAnswer(formData: FormData): Promise<void> {
  const user = await requireJobPermission();
  const label = String(formData.get("question") ?? "").trim();
  const answerType = String(formData.get("answerType") ?? "text") as JobAnswerType;
  if (!label || !["text", "boolean", "number", "date", "single_choice", "multi_choice"].includes(answerType)) throw new Error("Invalid answer");
  const options = String(formData.get("options") ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  const raw = String(formData.get("answer") ?? "");
  const answer: unknown = answerType === "boolean" ? raw === "true"
    : answerType === "number" ? Number(raw)
      : answerType === "multi_choice" ? raw.split(",").map((x) => x.trim()).filter(Boolean)
        : raw;
  const questionKey = jobAnswerMatchKey(label, answerType, options);
  const optionSignature = jobOptionSignature(answerType, options);
  await db().insert(jobAnswers).values({
    userId: user.id, questionKey, questionLabel: label, answerType, optionSignature,
    answerEncrypted: encryptStructured(answer, masterKey()), category: String(formData.get("category") ?? "custom"),
    isSensitive: formData.get("isSensitive") === "on",
  }).onConflictDoUpdate({
    target: [jobAnswers.userId, jobAnswers.questionKey, jobAnswers.optionSignature],
    set: { answerEncrypted: encryptStructured(answer, masterKey()), updatedAt: new Date() },
  });
  await audit({ actorUserId: user.id, action: "job.answer_saved", targetType: "job_answer", targetId: questionKey });
  revalidatePath("/jobs");
}

export async function deleteApplicationAnswer(answerId: string): Promise<void> {
  const user = await requireJobPermission();
  const rows = await db().delete(jobAnswers)
    .where(and(eq(jobAnswers.id, answerId), eq(jobAnswers.userId, user.id)))
    .returning({ id: jobAnswers.id });
  if (rows.length) {
    await audit({ actorUserId: user.id, action: "job.answer_deleted", targetType: "job_answer", targetId: answerId });
  }
  revalidatePath("/jobs");
}

export async function answerPendingQuestion(questionId: string, formData: FormData): Promise<void> {
  const user = await requireJobPermission();
  const [question] = await db().select().from(jobQuestions)
    .where(and(eq(jobQuestions.id, questionId), eq(jobQuestions.userId, user.id), eq(jobQuestions.status, "pending"))).limit(1);
  if (!question) return;
  const rawValues = formData.getAll("answer").map(String);
  const raw = rawValues[0] ?? "";
  const value: string | number | boolean | string[] | null = question.answerType === "boolean" ? raw === "true" ? true : raw === "false" ? false : null
    : question.answerType === "number" ? Number(raw)
      : question.answerType === "multi_choice" ? rawValues
        : raw;
  if (!validateJobAnswer(question.answerType, question.options ?? [], value)) throw new Error("Answer must match one of the exact portal options");
  const answer = value as string | number | boolean | string[];
  await db().transaction(async (tx) => {
    await tx.insert(jobAnswers).values({
      userId: user.id, questionKey: question.questionKey, questionLabel: question.questionLabel,
      answerType: question.answerType, optionSignature: question.optionSignature,
      answerEncrypted: encryptStructured(answer, masterKey()), category: "custom",
    }).onConflictDoUpdate({
      target: [jobAnswers.userId, jobAnswers.questionKey, jobAnswers.optionSignature],
      set: { answerEncrypted: encryptStructured(answer, masterKey()), updatedAt: new Date() },
    });
    await tx.update(jobQuestions).set({ status: "answered", answeredAt: new Date() }).where(eq(jobQuestions.id, question.id));
  });
  const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
    .where(and(eq(robotSessions.jobApplicationId, question.applicationId), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
    .orderBy(desc(robotSessions.startedAt)).limit(1);
  if (session) await sendJobAnswer(user, session.id, question.requestId, answer);
  await audit({ actorUserId: user.id, action: "job.answer_saved", targetType: "job_question", targetId: question.id });
  revalidatePath("/jobs");
}

export async function completeManualTakeover(applicationId: string): Promise<void> {
  const user = await requireJobPermission();
  const [application] = await db().select({ requestId: jobApplications.takeoverRequestId })
    .from(jobApplications)
    .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, user.id), eq(jobApplications.attentionKind, "needs_takeover"))).limit(1);
  if (!application?.requestId) return;
  const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
    .where(and(eq(robotSessions.jobApplicationId, applicationId), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
    .orderBy(desc(robotSessions.startedAt)).limit(1);
  if (session) await finishJobTakeover(user, session.id, application.requestId);
  revalidatePath("/jobs");
}

export async function cancelApplication(applicationId: string): Promise<void> {
  const user = await requireJobPermission();
  const rows = await db().update(jobApplications).set({
    status: "cancelled", statusDetail: "Cancelled by user", attentionKind: null, takeoverRequestId: null,
    finishedAt: new Date(), claimedBy: null, claimExpiresAt: null, updatedAt: new Date(),
  })
    .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, user.id), inArray(jobApplications.status, ["queued", "running", "needs_attention"])))
    .returning({ id: jobApplications.id });
  if (rows.length) {
    const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
      .where(and(eq(robotSessions.jobApplicationId, applicationId), eq(robotSessions.userId, user.id), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
      .orderBy(desc(robotSessions.startedAt)).limit(1);
    if (session) await stopRuntimeSession(user, session.id);
    await enqueueJobNotification(user.id, applicationId, "cancelled", "Application cancelled");
    await audit({ actorUserId: user.id, action: "job.application_cancelled", targetType: "job_application", targetId: applicationId });
  }
  revalidatePath("/jobs");
}

export async function retryApplication(applicationId: string): Promise<void> {
  const user = await requireJobPermission();
  const [application] = await db().select({ attentionKind: jobApplications.attentionKind, resumeId: jobApplications.resumeDocumentId })
    .from(jobApplications).where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, user.id))).limit(1);
  if (["needs_answer", "needs_takeover"].includes(application?.attentionKind ?? "")) return;
  if (!application?.resumeId) throw new Error("This application no longer has an available résumé");
  await assertJobApplicationReady(user.id, application.resumeId);
  await db().update(jobApplications).set({ status: "queued", statusDetail: "Queued for retry", attentionKind: null, failureReason: null, finishedAt: null, claimedBy: null, claimExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(jobApplications.id, applicationId), eq(jobApplications.userId, user.id), inArray(jobApplications.status, ["needs_attention", "failed"])));
  revalidatePath("/jobs");
}

export async function reapplyApplication(applicationId: string): Promise<void> {
  const user = await requireJobPermission();
  const [application] = await db().select({
    sourceUrl: jobApplications.sourceUrl,
    resumeId: jobApplications.resumeDocumentId,
  }).from(jobApplications).where(and(
    eq(jobApplications.id, applicationId),
    eq(jobApplications.userId, user.id),
    inArray(jobApplications.status, ["applied", "not_applied", "failed", "cancelled"]),
  )).limit(1);
  if (!application?.resumeId) throw new Error("This application no longer has an available résumé");
  await submitJobApplications(user, {
    links: [application.sourceUrl],
    resumeId: application.resumeId,
    reapply: true,
  });
  revalidatePath("/jobs");
}

export async function deleteApplication(applicationId: string): Promise<void> {
  const user = await requireJobPermission();
  const rows = await db().delete(jobApplications).where(and(
    eq(jobApplications.id, applicationId),
    eq(jobApplications.userId, user.id),
    inArray(jobApplications.status, ["applied", "not_applied", "failed", "cancelled"]),
  )).returning({ id: jobApplications.id });
  if (rows.length) await audit({ actorUserId: user.id, action: "job.application_deleted", targetType: "job_application", targetId: applicationId });
  revalidatePath("/jobs");
}

export async function disconnectGmail(): Promise<void> {
  const user = await requireJobPermission();
  await db().delete(jobConnections).where(and(eq(jobConnections.userId, user.id), eq(jobConnections.kind, "gmail")));
  await audit({ actorUserId: user.id, action: "job.gmail_disconnected", targetType: "job_connection", targetId: user.id });
  revalidatePath("/jobs");
}

export async function deletePortalCredential(accountId: string): Promise<void> {
  const user = await requireJobPermission();
  await db().delete(jobPortalAccounts).where(and(eq(jobPortalAccounts.id, accountId), eq(jobPortalAccounts.userId, user.id)));
  revalidatePath("/jobs");
}
