import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { robotSessions, sessionEvents, siteProfiles } from "@browserpilot/db";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

/** Everything the robot has downloaded, newest first, under its session. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const sessions = await db()
    .select({
      id: robotSessions.id,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(
      user.role === "ADMIN" || can(user, "session.view_others")
        ? undefined
        : eq(robotSessions.userId, user.id),
    )
    .orderBy(desc(robotSessions.startedAt))
    .limit(200);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  if (byId.size === 0) return NextResponse.json({ groups: [] });

  const events = await db()
    .select({
      robotSessionId: sessionEvents.robotSessionId,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .where(inArray(sessionEvents.robotSessionId, [...byId.keys()]))
    .orderBy(desc(sessionEvents.createdAt));

  const seen = new Set<string>();
  const groups = new Map<string, {
    sessionId: string;
    title: string;
    siteName: string | null;
    startedAt: string;
    files: Array<{ filename: string; url: string; at: string }>;
  }>();

  for (const event of events) {
    const payload = event.payload as { type?: string; filename?: string; url?: string };
    if (payload.type !== "file_ready" || !payload.filename || !payload.url) continue;

    const key = `${event.robotSessionId}:${payload.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const session = byId.get(event.robotSessionId);
    if (!session) continue;

    let group = groups.get(event.robotSessionId);
    if (!group) {
      group = {
        sessionId: session.id,
        title: session.title ?? session.siteName ?? "Session",
        siteName: session.siteName,
        startedAt: session.startedAt.toISOString(),
        files: [],
      };
      groups.set(event.robotSessionId, group);
    }
    group.files.push({
      filename: payload.filename,
      url: payload.url,
      at: event.createdAt.toISOString(),
    });
  }

  return NextResponse.json({ groups: [...groups.values()] });
}
