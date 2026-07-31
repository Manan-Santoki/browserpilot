import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { robotSessions, sessionEvents, siteProfiles } from "@browserpilot/db";
import { db } from "@/lib/db";
import {
  GeminiLiveRateLimitError,
  issueGeminiLiveToken,
} from "@/lib/gemini-live-server";
import { getCurrentUser } from "@/lib/session";

type ContextEvent = {
  type?: string;
  text?: string;
  speaker?: string;
};

function contextLine(payload: unknown): string | null {
  const event = payload as ContextEvent;
  const text = typeof event.text === "string" ? event.text.trim().slice(0, 700) : "";
  if (!text) return null;
  if (event.type === "user_msg") return `User browser request: ${text}`;
  if (event.type === "agent_text") return `Claude browser operator: ${text}`;
  if (event.type === "voice_transcript") {
    return `${event.speaker === "assistant" ? "Gemini voice" : "User voice"}: ${text}`;
  }
  return null;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const [session] = await db()
    .select({
      userId: robotSessions.userId,
      kind: robotSessions.kind,
      status: robotSessions.status,
      lastUrl: robotSessions.lastUrl,
      lastUserMessage: robotSessions.lastUserMessage,
      resumedFromSessionId: robotSessions.resumedFromSessionId,
      siteName: siteProfiles.name,
      siteUrl: siteProfiles.baseUrl,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "No such session" }, { status: 404 });
  if (user.role !== "ADMIN" && session.userId !== user.id) {
    return NextResponse.json({ error: "Not your session" }, { status: 403 });
  }
  if (
    session.kind !== "agent" ||
    ["stopped", "failed", "interrupted"].includes(session.status)
  ) {
    return NextResponse.json(
      { error: "Live Voice is available only for a running agent session." },
      { status: 409 },
    );
  }

  try {
    const historySessionIds = [
      ...(session.resumedFromSessionId ? [session.resumedFromSessionId] : []),
      id,
    ];
    const history = await db()
      .select({ payload: sessionEvents.payload })
      .from(sessionEvents)
      .where(
        and(
          inArray(sessionEvents.robotSessionId, historySessionIds),
          inArray(sessionEvents.type, ["user_msg", "agent_text", "voice_transcript"]),
        ),
      )
      .orderBy(desc(sessionEvents.createdAt))
      .limit(30);

    const context = [
      `Active site: ${session.siteName ?? "unnamed site"}`,
      `Site origin: ${session.siteUrl ?? "unknown"}`,
      `Current browser URL: ${session.lastUrl ?? session.siteUrl ?? "unknown"}`,
      `Browser session status: ${session.status}`,
      ...(session.lastUserMessage
        ? [`Most recent delegated browser request: ${session.lastUserMessage.slice(0, 700)}`]
        : []),
      "Recent conversation and browser results:",
      ...history
        .reverse()
        .map((row) => contextLine(row.payload))
        .filter((line): line is string => Boolean(line)),
    ].join("\n");

    const issued = await issueGeminiLiveToken(user.id, id, context);
    console.info(
      JSON.stringify({
        component: "live_voice",
        event: "token.issued",
        sessionId: id,
        historyMessages: history.length,
      }),
    );
    return NextResponse.json(issued);
  } catch (error) {
    if (error instanceof GeminiLiveRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
