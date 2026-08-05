import { and, desc, eq, inArray } from "drizzle-orm";
import { encryptStructured, validateJobAnswer } from "@browserpilot/core";
import { jobAnswers, jobQuestions, robotSessions } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { sendJobAnswer } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const id = (await context.params).id;
  const [question] = await db().select().from(jobQuestions).where(and(
    eq(jobQuestions.id, id),
    eq(jobQuestions.userId, user.id),
    eq(jobQuestions.status, "pending"),
  )).limit(1);
  if (!question) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { answer?: unknown };
  const value = body.answer;
  const valid = validateJobAnswer(question.answerType, question.options ?? [], value);
  if (!valid) return Response.json({ error: `answer must match ${question.answerType}` }, { status: 400 });
  const key = process.env.BP_MASTER_KEY;
  if (!key || key.length < 32) return Response.json({ error: "Private data encryption is unavailable" }, { status: 503 });
  await db().transaction(async (tx) => {
    await tx.insert(jobAnswers).values({
      userId: user.id,
      questionKey: question.questionKey,
      questionLabel: question.questionLabel,
      answerType: question.answerType,
      optionSignature: question.optionSignature,
      answerEncrypted: encryptStructured(value, key),
      category: "custom",
    }).onConflictDoUpdate({
      target: [jobAnswers.userId, jobAnswers.questionKey, jobAnswers.optionSignature],
      set: { answerEncrypted: encryptStructured(value, key), updatedAt: new Date() },
    });
    await tx.update(jobQuestions).set({ status: "answered", answeredAt: new Date() }).where(eq(jobQuestions.id, question.id));
  });
  const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
    .where(and(eq(robotSessions.jobApplicationId, question.applicationId), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
    .orderBy(desc(robotSessions.startedAt)).limit(1);
  if (session) await sendJobAnswer(user, session.id, question.requestId, value as string | number | boolean | string[]);
  await audit({ actorUserId: user.id, action: "job.answer_saved", targetType: "job_question", targetId: question.id });
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
