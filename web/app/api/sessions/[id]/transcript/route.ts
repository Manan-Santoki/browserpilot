import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { robotSessions } from "@browserpilot/db";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { canViewSession } from "@/lib/session-access";
import { loadTranscript } from "@/lib/transcript";

type VoiceTranscriptBody = {
  kind?: "transcript";
  messageId?: string;
  speaker?: "user" | "assistant";
  text?: string;
  inputModality?: "text" | "audio";
  outputModality?: "text" | "audio";
};

type VoiceTelemetryBody = {
  kind?: "telemetry";
  event?: string;
  level?: "info" | "warn" | "error";
  detail?: string;
};

async function authorizeSession(id: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) {
    return { error: NextResponse.json({ error: "No such session" }, { status: 404 }) };
  }
  if (!(await canViewSession(user, id))) {
    return { error: NextResponse.json({ error: "Not your session" }, { status: 403 }) };
  }
  return { user };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorizeSession(id);
  if (access.error) return access.error;
  return NextResponse.json({ items: await loadTranscript(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await authorizeSession(id);
  if (access.error) return access.error;

  const body = (await req.json().catch(() => ({}))) as
    | VoiceTranscriptBody
    | VoiceTelemetryBody;

  if (body.kind === "telemetry") {
    const event =
      typeof body.event === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(body.event)
        ? body.event
        : "invalid";
    const level = ["info", "warn", "error"].includes(body.level ?? "")
      ? (body.level as "info" | "warn" | "error")
      : "info";
    const entry = JSON.stringify({
      component: "live_voice",
      event,
      sessionId: id,
      detail: typeof body.detail === "string" ? body.detail.slice(0, 500) : undefined,
    });
    console[level](entry);
    return NextResponse.json({ logged: true });
  }

  const transcript = body as VoiceTranscriptBody;
  const messageId =
    typeof transcript.messageId === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(transcript.messageId)
      ? transcript.messageId
      : "";
  const text =
    typeof transcript.text === "string" ? transcript.text.trim().slice(0, 12_000) : "";
  const speaker = transcript.speaker;
  const inputModality = transcript.inputModality;
  const outputModality = transcript.outputModality;

  if (
    transcript.kind !== "transcript" ||
    !messageId ||
    !text ||
    !["user", "assistant"].includes(speaker ?? "") ||
    !["text", "audio"].includes(inputModality ?? "") ||
    !["text", "audio"].includes(outputModality ?? "")
  ) {
    return NextResponse.json({ error: "Invalid Live Voice transcript" }, { status: 400 });
  }

  const event = {
    type: "voice_transcript",
    messageId,
    speaker,
    text,
    inputModality,
    outputModality,
  };

  // Updating the parent row serializes sequence allocation with runtime writes.
  // The message id makes retries idempotent without a second table.
  await db().execute(sql`
    with next_event as (
      update "robot_sessions"
      set "event_seq" = "event_seq" + 1,
          "last_activity_at" = now()
      where "id" = ${id}::uuid
        and not exists (
          select 1
          from "session_events"
          where "robot_session_id" = ${id}::uuid
            and "type" = 'voice_transcript'
            and "payload"->>'messageId' = ${messageId}
        )
      returning "event_seq"
    )
    insert into "session_events" ("robot_session_id", "seq", "type", "payload")
    select
      ${id}::uuid,
      next_event."event_seq",
      'voice_transcript',
      ${JSON.stringify(event)}::jsonb
    from next_event
  `);

  console.info(
    JSON.stringify({
      component: "live_voice",
      event: "transcript.saved",
      sessionId: id,
      messageId,
      speaker,
      inputModality,
      outputModality,
      characters: text.length,
      transcript: process.env.LIVE_VOICE_LOG_TRANSCRIPTS === "true" ? text : undefined,
    }),
  );
  return NextResponse.json({ saved: true });
}
