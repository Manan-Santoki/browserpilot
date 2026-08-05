import { desc, eq } from "drizzle-orm";
import { encryptStructured, jobAnswerMatchKey, jobOptionSignature, validateJobAnswer, type JobAnswerType } from "@browserpilot/core";
import { jobAnswers } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

const TYPES = ["text", "boolean", "number", "date", "single_choice", "multi_choice"] as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const answers = await db().select({
    id: jobAnswers.id,
    question: jobAnswers.questionLabel,
    category: jobAnswers.category,
    answerType: jobAnswers.answerType,
    optionSignature: jobAnswers.optionSignature,
    isSensitive: jobAnswers.isSensitive,
    createdAt: jobAnswers.createdAt,
    updatedAt: jobAnswers.updatedAt,
  }).from(jobAnswers).where(eq(jobAnswers.userId, user.id)).orderBy(desc(jobAnswers.updatedAt));
  return Response.json({ answers }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as {
    question?: string;
    answerType?: JobAnswerType;
    options?: string[];
    answer?: unknown;
    category?: string;
    isSensitive?: boolean;
  };
  const question = body.question?.trim() ?? "";
  const answerType = body.answerType ?? "text";
  const options = Array.isArray(body.options) ? body.options.map((option) => String(option).trim()).filter(Boolean) : [];
  if (!question || !TYPES.includes(answerType as typeof TYPES[number]) || body.answer === undefined) {
    return Response.json({ error: "question, answerType, and answer are required" }, { status: 400 });
  }
  if (question.length > 5_000 || options.length > 300 || options.some((option) => option.length > 300)) {
    return Response.json({ error: "question or option inventory exceeds the supported portal limits" }, { status: 400 });
  }
  if (!validateJobAnswer(answerType, options, body.answer)) {
    return Response.json({ error: "answer must match the exact portal type and options" }, { status: 400 });
  }
  const key = process.env.BP_MASTER_KEY;
  if (!key || key.length < 32) return Response.json({ error: "Private data encryption is unavailable" }, { status: 503 });
  const questionKey = jobAnswerMatchKey(question, answerType, options);
  const optionSignature = jobOptionSignature(answerType, options);
  const [answer] = await db().insert(jobAnswers).values({
    userId: user.id,
    questionKey,
    questionLabel: question,
    answerType,
    optionSignature,
    answerEncrypted: encryptStructured(body.answer, key),
    category: body.category?.slice(0, 80) || "custom",
    isSensitive: body.isSensitive === true,
  }).onConflictDoUpdate({
    target: [jobAnswers.userId, jobAnswers.questionKey, jobAnswers.optionSignature],
    set: { answerEncrypted: encryptStructured(body.answer, key), updatedAt: new Date() },
  }).returning({ id: jobAnswers.id });
  await audit({ actorUserId: user.id, action: "job.answer_saved", targetType: "job_answer", targetId: answer!.id });
  return Response.json({ id: answer!.id }, { status: 201, headers: { "cache-control": "no-store" } });
}
