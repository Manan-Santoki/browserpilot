import { and, desc, eq, inArray } from "drizzle-orm";
import { jobApplicationEvents, jobApplications, jobQuestions, robotSessions } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertJobApplicationReady, submitJobApplications } from "@/lib/job-applications";
import { enqueueJobNotification } from "@/lib/job-notifications";
import { getCurrentUser } from "@/lib/session";
import { stopRuntimeSession } from "@/lib/runtime";

async function ownedApplication(userId: string, id: string) {
  const [application] = await db().select().from(jobApplications)
    .where(and(eq(jobApplications.id, id), eq(jobApplications.userId, userId))).limit(1);
  return application ?? null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const application = await ownedApplication(user.id, (await context.params).id);
  if (!application) return Response.json({ error: "Not found" }, { status: 404 });
  const [events, questions] = await Promise.all([
    db().select().from(jobApplicationEvents).where(eq(jobApplicationEvents.applicationId, application.id)).orderBy(desc(jobApplicationEvents.createdAt)),
    db().select().from(jobQuestions).where(and(eq(jobQuestions.applicationId, application.id), eq(jobQuestions.userId, user.id))).orderBy(desc(jobQuestions.createdAt)),
  ]);
  return Response.json({ application, events, questions }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const application = await ownedApplication(user.id, (await context.params).id);
  if (!application) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { action?: "cancel" | "retry" | "reapply"; resumeId?: string };

  if (body.action === "cancel") {
    const rows = await db().update(jobApplications).set({
      status: "cancelled", statusDetail: "Cancelled by user", attentionKind: null, takeoverRequestId: null,
      finishedAt: new Date(), claimedBy: null, claimExpiresAt: null, updatedAt: new Date(),
    })
      .where(and(eq(jobApplications.id, application.id), eq(jobApplications.userId, user.id), inArray(jobApplications.status, ["queued", "running", "needs_attention"])))
      .returning({ id: jobApplications.id });
    if (rows.length) {
      const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
        .where(and(eq(robotSessions.jobApplicationId, application.id), eq(robotSessions.userId, user.id), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
        .orderBy(desc(robotSessions.startedAt)).limit(1);
      if (session) await stopRuntimeSession(user, session.id);
      await enqueueJobNotification(user.id, application.id, "cancelled", "Application cancelled");
      await audit({ actorUserId: user.id, action: "job.application_cancelled", targetType: "job_application", targetId: application.id });
    }
    return Response.json({ ok: rows.length > 0 }, { headers: { "cache-control": "no-store" } });
  }

  if (body.action === "retry") {
    if (["needs_answer", "needs_takeover"].includes(application.attentionKind ?? "")) {
      return Response.json({ error: "Answer the pending question or complete takeover instead of retrying" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    if (!application.resumeDocumentId) return Response.json({ error: "The selected résumé is unavailable" }, { status: 409, headers: { "cache-control": "no-store" } });
    try {
      await assertJobApplicationReady(user.id, application.resumeDocumentId);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
      .where(and(eq(robotSessions.jobApplicationId, application.id), eq(robotSessions.userId, user.id)))
      .orderBy(desc(robotSessions.startedAt)).limit(1);
    if (session) await stopRuntimeSession(user, session.id);
    // Request ids are scoped to an agent run and restart from jobq_1. These
    // rows are transient UI cards; durable encrypted answers live separately.
    await db().delete(jobQuestions).where(and(
      eq(jobQuestions.applicationId, application.id),
      eq(jobQuestions.userId, user.id),
    ));
    const rows = await db().update(jobApplications).set({ status: "queued", statusDetail: "Queued for retry", attentionKind: null, failureReason: null, finishedAt: null, claimedBy: null, claimExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(jobApplications.id, application.id), eq(jobApplications.userId, user.id), inArray(jobApplications.status, ["needs_attention", "failed"])))
      .returning({ id: jobApplications.id });
    return Response.json({ ok: rows.length > 0 }, { headers: { "cache-control": "no-store" } });
  }

  if (body.action === "reapply") {
    const resumeId = body.resumeId ?? application.resumeDocumentId;
    if (!resumeId) return Response.json({ error: "resumeId is required" }, { status: 400 });
    try {
      const applications = await submitJobApplications(user, { links: [application.sourceUrl], resumeId, reapply: true });
      return Response.json({ applications }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  return Response.json({ error: "action must be cancel, retry, or reapply" }, { status: 400 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const id = (await context.params).id;
  const rows = await db().delete(jobApplications).where(and(
    eq(jobApplications.id, id),
    eq(jobApplications.userId, user.id),
    inArray(jobApplications.status, ["applied", "not_applied", "failed", "cancelled"]),
  )).returning({ id: jobApplications.id });
  if (!rows.length) return Response.json({ error: "Not found or still active" }, { status: 404 });
  await audit({ actorUserId: user.id, action: "job.application_deleted", targetType: "job_application", targetId: id });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
